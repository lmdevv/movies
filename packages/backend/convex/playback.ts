/**
 * Per-device playback sessions. Creating one signs a playback token for the media service; each
 * device then reports its own position, and a report from an older session of the same profile
 * cannot overwrite a newer one's progress. Downloads (`downloads.ts`) are sessions too; they leave
 * the device's playback alone and report no progress.
 */
import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { loadAudience, loadVisibleTitle } from "./lib/access";
import { checkDeviceId, checkMilliseconds } from "./lib/bounds";
import { endPlaybackSession } from "./lib/endings";
import { fail } from "./lib/errors";
import { presentEpisodeFor, presentPlaybackSession } from "./lib/present";
import {
  clientCapabilities,
  episode,
  ok,
  playbackSession,
  progressEvent,
  progressReceipt,
  renewedToken,
  startedPlayback,
} from "./lib/validators";
import {
  activeSessions,
  choosePlayable,
  isDownload,
  issueToken,
  loadOwnSession,
  openSession,
} from "./lib/sessions";
import type { Viewer } from "./lib/viewer";
import { authorize } from "./lib/viewer";
import { nextEpisodeAfter, reachedEnd, writeProgress } from "./lib/viewing";

/** Most devices one account plays on at once; starting another ends the quietest. */
const MAX_ACTIVE_SESSIONS = 8;

/** Where a room member's stream starts: the room's file, with the member's own session. */
const roomFile = async (
  ctx: MutationCtx,
  viewer: Viewer,
  roomId: Id<"rooms">,
  profileId: Id<"profiles">,
  deviceId: string,
): Promise<Doc<"rooms">> => {
  const room = await ctx.db.get(roomId);

  if (room === null || room.status === "ended") return fail("not_found", "This room has ended");

  const member = await ctx.db
    .query("roomMembers")
    .withIndex("by_room_device", (q) => q.eq("roomId", roomId).eq("deviceId", deviceId))
    .unique();

  if (member?.userId !== viewer.userId || member.profileId !== profileId) {
    return fail("forbidden", "Join the room on this device first");
  }

  return room;
};

/**
 * Starts playback on a device and signs a playback token for the media service, resuming where the
 * profile left off unless it finished. Without `fileId` it plays the version the profile last
 * played while that is on disk, else the best the device's `capabilities` play directly, else the
 * best quality. Requires `play` scope. Ends this device's earlier session,
 * and past eight devices the account's quietest sessions. With `roomId` the room's file plays, and
 * the device must have joined the room with this profile.
 */
export const createSession = mutation({
  args: {
    profileId: v.id("profiles"),
    deviceId: v.string(),
    deviceName: v.optional(v.string()),
    titleId: v.id("titles"),
    episodeId: v.optional(v.id("episodes")),
    fileId: v.optional(v.id("mediaFiles")),
    roomId: v.optional(v.id("rooms")),
    capabilities: v.optional(clientCapabilities),
  },
  returns: startedPlayback,
  handler: async (ctx, args) => {
    const viewer = await authorize(ctx, "play");
    checkDeviceId(args.deviceId);
    const audience = await loadAudience(ctx, viewer, args.profileId);
    const title = await loadVisibleTitle(ctx, audience, args.titleId);

    const room =
      args.roomId === undefined
        ? null
        : await roomFile(ctx, viewer, args.roomId, args.profileId, args.deviceId);

    if (room !== null && room.titleId !== title._id) {
      return fail("invalid_args", "The room is playing another title");
    }

    const chosen = await choosePlayable(ctx, args.profileId, title, {
      episodeId: room?.episodeId ?? args.episodeId ?? null,
      fileId: room?.fileId ?? args.fileId ?? null,
      capabilities: args.capabilities ?? null,
    });

    const now = Date.now();

    const previous = (await activeSessions(ctx, viewer)).filter((session) => !isDownload(session));

    // One device plays one thing: starting here ends this device's earlier session. An account
    // plays on at most `MAX_ACTIVE_SESSIONS` devices; past that, the quietest sessions end, so one
    // account cannot hold an unbounded number of streams on the media service.
    const otherDevices = previous
      .filter((session) => session.deviceId !== args.deviceId)
      .toSorted((left, right) => right.lastReportAt - left.lastReportAt);

    const ending = [
      ...previous.filter((session) => session.deviceId === args.deviceId),
      ...otherDevices.slice(MAX_ACTIVE_SESSIONS - 1),
    ];

    await Promise.all(ending.map((session) => endPlaybackSession(ctx, session, now)));

    return openSession(ctx, viewer, {
      args,
      chosen,
      roomId: room?._id ?? null,
      purpose: undefined,
      now,
    });
  },
});

/**
 * Signs a fresh playback token for an active session, after checking the profile may still see the
 * title. Fails with `conflict` once the session ended. Renewing keeps a download session active.
 */
export const renewToken = mutation({
  args: { sessionId: v.id("playbackSessions") },
  returns: renewedToken,
  handler: async (ctx, { sessionId }) => {
    const viewer = await authorize(ctx, "play");
    const session = await loadOwnSession(ctx, viewer, sessionId);

    if (session.status !== "active") return fail("conflict", "This playback session has ended");

    // The profile may have been locked or limited, or the library's grant revoked, since it began.
    await loadVisibleTitle(
      ctx,
      await loadAudience(ctx, viewer, session.profileId),
      session.titleId,
    );

    // A download reports nothing else, so renewing is what keeps it from going idle.
    if (isDownload(session)) await ctx.db.patch(sessionId, { lastReportAt: Date.now() });

    return issueToken(session);
  },
});

const recordPosition = async (
  ctx: MutationCtx,
  session: Doc<"playbackSessions">,
  positionMs: number,
  durationMs: number | undefined,
  ended: boolean,
): Promise<{ readonly applied: boolean; readonly watched: boolean }> => {
  const file = await ctx.db.get(session.fileId);
  const duration = durationMs ?? file?.probe.durationMs ?? 0;

  return writeProgress(ctx, {
    profileId: session.profileId,
    titleId: session.titleId,
    episodeId: session.episodeId,
    fileId: session.fileId,
    positionMs,
    durationMs: duration,
    watched: ended || reachedEnd(positionMs, duration),
    playedAt: Date.now(),
    session,
  });
};

/**
 * Records a device's position and play state and saves it as the profile's progress. `applied` is
 * false when the session ended or a newer session owns the item's progress; reaching the end or an
 * `ended` event marks the item watched.
 */
export const reportProgress = mutation({
  args: {
    sessionId: v.id("playbackSessions"),
    positionMs: v.number(),
    durationMs: v.optional(v.number()),
    event: progressEvent,
  },
  returns: progressReceipt,
  handler: async (ctx, { sessionId, positionMs, durationMs, event }) => {
    const viewer = await authorize(ctx, "play");
    const session = await loadOwnSession(ctx, viewer, sessionId);

    checkMilliseconds(positionMs, "Positions");

    if (durationMs !== undefined) checkMilliseconds(durationMs, "Durations");

    if (session.status !== "active" || isDownload(session)) {
      return { applied: false, watched: false };
    }

    await ctx.db.patch(sessionId, {
      positionMs,
      state: event === "pause" || event === "ended" ? "paused" : "playing",
      lastReportAt: Date.now(),
    });

    return recordPosition(ctx, session, positionMs, durationMs, event === "ended");
  },
});

/**
 * Saves the final position and ends the session, so the media service stops its streams. Ending an
 * ended session is harmless.
 */
export const endSession = mutation({
  args: { sessionId: v.id("playbackSessions"), positionMs: v.number() },
  returns: ok,
  handler: async (ctx, { sessionId, positionMs }) => {
    const viewer = await authorize(ctx, "play");
    const session = await loadOwnSession(ctx, viewer, sessionId);

    if (session.status === "ended") return { ok: true as const };

    checkMilliseconds(positionMs, "Positions");

    if (!isDownload(session)) await recordPosition(ctx, session, positionMs, undefined, false);
    const now = Date.now();

    await ctx.db.patch(sessionId, { positionMs, lastReportAt: now });
    await endPlaybackSession(ctx, session, now);

    return { ok: true as const };
  },
});

/**
 * The episode after this one in season order, specials last, with the profile's progress; null
 * after the last.
 */
export const nextEpisode = query({
  args: { profileId: v.id("profiles"), episodeId: v.id("episodes") },
  returns: v.union(v.null(), episode),
  handler: async (ctx, { profileId, episodeId }) => {
    const viewer = await authorize(ctx, "read");
    const audience = await loadAudience(ctx, viewer, profileId);
    const current = await ctx.db.get(episodeId);

    if (current === null) return fail("not_found", "No such episode");
    await loadVisibleTitle(ctx, audience, current.titleId);
    const next = await nextEpisodeAfter(ctx, current);

    return next === null ? null : presentEpisodeFor(ctx, profileId, next);
  },
});

/** The account's active playback sessions on every device; downloads are not playback. */
export const active = query({
  args: {},
  returns: v.array(playbackSession),
  handler: async (ctx) => {
    const viewer = await authorize(ctx, "read");
    const sessions = await activeSessions(ctx, viewer);

    return sessions.flatMap((session) =>
      isDownload(session) ? [] : [presentPlaybackSession(session)],
    );
  },
});
