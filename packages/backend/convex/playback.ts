/**
 * Per-device playback sessions. Creating one signs a playback token for the media service; each
 * device then reports its own position, and a report from an older session of the same profile
 * cannot overwrite a newer one's progress.
 */
import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { loadAudience, loadVisibleTitle } from "./lib/access";
import { fail } from "./lib/errors";
import { resolvePlayable } from "./lib/playable";
import {
  mediaBaseUrl,
  PLAYBACK_TOKEN_LIFETIME_MS,
  playbackTokenSecret,
  signPlaybackToken,
} from "./lib/playbackToken";
import {
  findProgress,
  presentEpisodeFor,
  presentMediaFile,
  presentPlaybackSession,
} from "./lib/present";
import {
  episode,
  ok,
  playbackSession,
  progressEvent,
  progressReceipt,
  renewedToken,
  startedPlayback,
} from "./lib/validators";
import type { Viewer } from "./lib/viewer";
import { authorize } from "./lib/viewer";
import { nextEpisodeAfter, reachedEnd, writeProgress } from "./lib/viewing";

const issueToken = async (
  session: Doc<"playbackSessions">,
): Promise<{ readonly token: string; readonly tokenExpiresAt: number }> => {
  const iat = Date.now();
  const tokenExpiresAt = iat + PLAYBACK_TOKEN_LIFETIME_MS;

  const token = await signPlaybackToken(playbackTokenSecret(), {
    sub: session.userId,
    pid: session.profileId,
    fid: session.fileId,
    sid: session._id,
    iat,
    exp: tokenExpiresAt,
  });

  return { token, tokenExpiresAt };
};

const loadOwnSession = async (
  ctx: MutationCtx,
  viewer: Viewer,
  sessionId: Id<"playbackSessions">,
): Promise<Doc<"playbackSessions">> => {
  const session = await ctx.db.get(sessionId);

  if (session?.userId !== viewer.userId) return fail("not_found", "No such playback session");

  return session;
};

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

export const createSession = mutation({
  args: {
    profileId: v.id("profiles"),
    deviceId: v.string(),
    deviceName: v.optional(v.string()),
    titleId: v.id("titles"),
    episodeId: v.optional(v.id("episodes")),
    fileId: v.optional(v.id("mediaFiles")),
    roomId: v.optional(v.id("rooms")),
  },
  returns: startedPlayback,
  handler: async (ctx, args) => {
    const viewer = await authorize(ctx, "play");
    const audience = await loadAudience(ctx, viewer, args.profileId);
    const title = await loadVisibleTitle(ctx, audience, args.titleId);

    const room =
      args.roomId === undefined
        ? null
        : await roomFile(ctx, viewer, args.roomId, args.profileId, args.deviceId);

    if (room !== null && room.titleId !== title._id) {
      return fail("invalid_args", "The room is playing another title");
    }

    const playable = await resolvePlayable(
      ctx,
      title,
      room?.episodeId ?? args.episodeId ?? null,
      room?.fileId ?? args.fileId ?? null,
    );

    const episodeId = playable.episode?._id ?? null;
    const saved = await findProgress(ctx, args.profileId, title._id, episodeId);

    const resumePositionMs =
      saved === null || reachedEnd(saved.positionMs, saved.durationMs) ? 0 : saved.positionMs;

    const now = Date.now();

    const previous = await ctx.db
      .query("playbackSessions")
      .withIndex("by_user_status", (q) => q.eq("userId", viewer.userId).eq("status", "active"))
      .collect();

    // One device plays one thing: starting here ends this device's earlier session.
    await Promise.all(
      previous.flatMap((session) =>
        session.deviceId === args.deviceId
          ? [ctx.db.patch(session._id, { status: "ended" as const, endedAt: now })]
          : [],
      ),
    );

    const sessionId = await ctx.db.insert("playbackSessions", {
      userId: viewer.userId,
      profileId: args.profileId,
      authSessionId: viewer.session._id,
      deviceId: args.deviceId,
      deviceName: args.deviceName?.trim() ?? null,
      titleId: title._id,
      episodeId,
      fileId: playable.file._id,
      roomId: room?._id ?? null,
      mode: null,
      status: "active",
      state: "paused",
      positionMs: resumePositionMs,
      startedAt: now,
      lastReportAt: now,
      endedAt: null,
    });

    const session = await ctx.db.get(sessionId);

    if (session === null)
      return fail("internal", "The playback session vanished right after it was created");
    const { token, tokenExpiresAt } = await issueToken(session);

    return {
      sessionId,
      titleId: title._id,
      episodeId,
      file: presentMediaFile(playable.file),
      token,
      tokenExpiresAt,
      mediaBaseUrl: mediaBaseUrl(),
      resumePositionMs,
    };
  },
});

export const renewToken = mutation({
  args: { sessionId: v.id("playbackSessions") },
  returns: renewedToken,
  handler: async (ctx, { sessionId }) => {
    const viewer = await authorize(ctx, "play");
    const session = await loadOwnSession(ctx, viewer, sessionId);

    if (session.status !== "active") return fail("conflict", "This playback session has ended");

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

    if (session.status !== "active") return { applied: false, watched: false };

    if (!Number.isFinite(positionMs) || positionMs < 0) {
      return fail("invalid_args", "Positions are zero or more milliseconds");
    }

    await ctx.db.patch(sessionId, {
      positionMs,
      state: event === "pause" || event === "ended" ? "paused" : "playing",
      lastReportAt: Date.now(),
    });

    return recordPosition(ctx, session, positionMs, durationMs, event === "ended");
  },
});

export const endSession = mutation({
  args: { sessionId: v.id("playbackSessions"), positionMs: v.number() },
  returns: ok,
  handler: async (ctx, { sessionId, positionMs }) => {
    const viewer = await authorize(ctx, "play");
    const session = await loadOwnSession(ctx, viewer, sessionId);

    if (session.status === "ended") return { ok: true as const };

    await recordPosition(ctx, session, positionMs, undefined, false);
    const now = Date.now();

    await ctx.db.patch(sessionId, {
      status: "ended",
      state: "paused",
      positionMs,
      lastReportAt: now,
      endedAt: now,
    });

    return { ok: true as const };
  },
});

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

export const active = query({
  args: {},
  returns: v.array(playbackSession),
  handler: async (ctx) => {
    const viewer = await authorize(ctx, "read");

    const sessions = await ctx.db
      .query("playbackSessions")
      .withIndex("by_user_status", (q) => q.eq("userId", viewer.userId).eq("status", "active"))
      .collect();

    return sessions.map(presentPlaybackSession);
  },
});
