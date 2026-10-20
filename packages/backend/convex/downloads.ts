/**
 * Downloads a device keeps. A download is a playback session with `purpose: "download"`, so
 * signing out, losing access, or removing a library stops it as it stops playback. It reports no
 * progress; the device saves what it plays, possibly offline, with `recordProgress`.
 */
import { v } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import { mutation } from "./_generated/server";
import { loadAudience, loadVisibleTitle } from "./lib/access";
import { checkDeviceId, checkMilliseconds } from "./lib/bounds";
import { endPlaybackSession } from "./lib/endings";
import { fail } from "./lib/errors";
import { resolveEpisode } from "./lib/playable";
import { findProgress } from "./lib/present";
import {
  activeSessions,
  choosePlayable,
  isDownload,
  loadOwnSession,
  openSession,
} from "./lib/sessions";
import { clientCapabilities, ok, progressReceipt, startedPlayback } from "./lib/validators";
import { authorize } from "./lib/viewer";
import { reachedEnd, writeProgress } from "./lib/viewing";

/** Most files one device downloads at once; starting another ends the quietest. */
const MAX_DEVICE_DOWNLOADS = 4;

/**
 * Most files one account downloads at once on all its devices, beside the eight devices it plays
 * on; starting another ends the quietest, so downloads cannot hold unbounded media service work.
 */
const MAX_ACCOUNT_DOWNLOADS = 8;

/**
 * Starts downloading a movie or episode to keep on this device and signs a playback token for the
 * media service, with the checks playback has: the profile, its age limit, and its libraries.
 * The file is chosen as `createSession` chooses it. The device's playback goes on; downloading the
 * same file again ends its earlier download, and past four downloads on one device or eight on the
 * account the quietest ends. Renew the token with `playback.renewToken` and end the session with `end` when done.
 */
export const start = mutation({
  args: {
    profileId: v.id("profiles"),
    deviceId: v.string(),
    deviceName: v.optional(v.string()),
    titleId: v.id("titles"),
    episodeId: v.optional(v.id("episodes")),
    fileId: v.optional(v.id("mediaFiles")),
    capabilities: v.optional(clientCapabilities),
  },
  returns: startedPlayback,
  handler: async (ctx, args) => {
    const viewer = await authorize(ctx, "play");
    checkDeviceId(args.deviceId);
    const audience = await loadAudience(ctx, viewer, args.profileId);
    const title = await loadVisibleTitle(ctx, audience, args.titleId);

    const chosen = await choosePlayable(ctx, args.profileId, title, {
      episodeId: args.episodeId ?? null,
      fileId: args.fileId ?? null,
      capabilities: args.capabilities ?? null,
    });

    const now = Date.now();

    const downloads = (await activeSessions(ctx, viewer)).filter(isDownload);

    const replaced = (session: Doc<"playbackSessions">) =>
      session.deviceId === args.deviceId && session.fileId === chosen.playable.file._id;

    // Busiest first, so the quietest fall past each cap.
    const others = downloads
      .filter((session) => !replaced(session))
      .toSorted((left, right) => right.lastReportAt - left.lastReportAt);

    const overDevice = new Set(
      others
        .filter((session) => session.deviceId === args.deviceId)
        .slice(MAX_DEVICE_DOWNLOADS - 1),
    );

    const overAccount = others
      .filter((session) => !overDevice.has(session))
      .slice(MAX_ACCOUNT_DOWNLOADS - 1);

    const ending = [...downloads.filter(replaced), ...overDevice, ...overAccount];

    await Promise.all(ending.map((session) => endPlaybackSession(ctx, session, now)));

    return openSession(ctx, viewer, { args, chosen, roomId: null, purpose: "download", now });
  },
});

/** Ends a download session once its file is on the device, or when it is cancelled. */
export const end = mutation({
  args: { sessionId: v.id("playbackSessions") },
  returns: ok,
  handler: async (ctx, { sessionId }) => {
    const viewer = await authorize(ctx, "play");
    const session = await loadOwnSession(ctx, viewer, sessionId);

    if (!isDownload(session)) return fail("invalid_args", "This session is not a download");

    if (session.status === "active") await endPlaybackSession(ctx, session, Date.now());

    return { ok: true as const };
  },
});

/**
 * Saves progress a device made playing a download, possibly offline and long ago. It applies
 * unless the item was played elsewhere since `playedAt` (`applied: false`); reaching 90 percent
 * marks it watched. The profile must still see the title.
 */
export const recordProgress = mutation({
  args: {
    profileId: v.id("profiles"),
    titleId: v.id("titles"),
    episodeId: v.optional(v.id("episodes")),
    fileId: v.id("mediaFiles"),
    positionMs: v.number(),
    durationMs: v.number(),
    playedAt: v.number(),
  },
  returns: progressReceipt,
  handler: async (ctx, args) => {
    const viewer = await authorize(ctx, "play");
    checkMilliseconds(args.positionMs, "Positions");
    checkMilliseconds(args.durationMs, "Durations");
    checkMilliseconds(args.playedAt, "Play times");
    const audience = await loadAudience(ctx, viewer, args.profileId);
    const title = await loadVisibleTitle(ctx, audience, args.titleId);
    const played = await resolveEpisode(ctx, title, args.episodeId ?? null);
    const episodeId = played?._id ?? null;
    const file = await ctx.db.get(args.fileId);

    // The file may have left the disk since it was downloaded; it must still be this item's.
    if (file?.titleId !== title._id || file.episodeId !== episodeId) {
      return fail("not_found", "No such file for this title");
    }

    const playedAt = Math.min(args.playedAt, Date.now());
    const saved = await findProgress(ctx, args.profileId, title._id, episodeId);

    if (saved !== null && saved.lastPlayedAt >= playedAt) {
      return { applied: false, watched: saved.watched };
    }

    return writeProgress(ctx, {
      profileId: args.profileId,
      titleId: title._id,
      episodeId,
      fileId: file._id,
      positionMs: args.positionMs,
      durationMs: args.durationMs,
      watched: reachedEnd(args.positionMs, args.durationMs),
      playedAt,
      session: null,
    });
  },
});
