import type { Infer } from "convex/values";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { checkDisplayName } from "./bounds";
import { fail } from "./errors";
import type { Playable } from "./playable";
import { resolveEpisode, resolvePlayable } from "./playable";
import {
  mediaBaseUrl,
  PLAYBACK_TOKEN_LIFETIME_MS,
  playbackTokenSecret,
  signPlaybackToken,
} from "./playbackToken";
import { findProgress, presentEpisodeFor, presentMediaFile } from "./present";
import type { clientCapabilities, startedPlayback } from "./validators";
import type { ReadCtx, Viewer } from "./viewer";
import { reachedEnd } from "./viewing";

/** Whether `session` is a download rather than playback. */
export const isDownload = (session: Doc<"playbackSessions">): boolean =>
  session.purpose === "download";

/** Signs a fresh playback token for `session`; a download's names its purpose. */
export const issueToken = async (
  session: Doc<"playbackSessions">,
): Promise<{ readonly token: string; readonly tokenExpiresAt: number }> => {
  const iat = Date.now();
  const tokenExpiresAt = iat + PLAYBACK_TOKEN_LIFETIME_MS;

  const claims = {
    sub: session.userId,
    pid: session.profileId,
    fid: session.fileId,
    sid: session._id,
    iat,
    exp: tokenExpiresAt,
  };

  const token = await signPlaybackToken(
    playbackTokenSecret(),
    isDownload(session) ? { ...claims, pur: "download" } : claims,
  );

  return { token, tokenExpiresAt };
};

/** The viewer's own session `sessionId`; `not_found` for anyone else's. */
export const loadOwnSession = async (
  ctx: MutationCtx,
  viewer: Viewer,
  sessionId: Id<"playbackSessions">,
): Promise<Doc<"playbackSessions">> => {
  const session = await ctx.db.get(sessionId);

  if (session?.userId !== viewer.userId) return fail("not_found", "No such playback session");

  return session;
};

/** The account's active sessions, playback and downloads, on every device. */
export const activeSessions = (
  ctx: ReadCtx,
  viewer: Viewer,
): Promise<Array<Doc<"playbackSessions">>> =>
  ctx.db
    .query("playbackSessions")
    .withIndex("by_user_status", (q) => q.eq("userId", viewer.userId).eq("status", "active"))
    .collect();

/** What a new session plays, and where it resumes. */
export interface Chosen {
  readonly playable: Playable;
  readonly resumePositionMs: number;
}

/**
 * The file a new session plays, by `resolvePlayable`'s order, and the profile's saved position in
 * it unless the item was finished.
 */
export const choosePlayable = async (
  ctx: MutationCtx,
  profileId: Id<"profiles">,
  title: Doc<"titles">,
  wanted: {
    readonly episodeId: Id<"episodes"> | null;
    readonly fileId: Id<"mediaFiles"> | null;
    readonly capabilities: Infer<typeof clientCapabilities> | null;
  },
): Promise<Chosen> => {
  const played = await resolveEpisode(ctx, title, wanted.episodeId);
  const saved = await findProgress(ctx, profileId, title._id, played?._id ?? null);

  const playable = await resolvePlayable(ctx, title, played, wanted.fileId, {
    lastPlayed: saved?.fileId ?? null,
    client: wanted.capabilities,
  });

  const resumePositionMs =
    saved === null || reachedEnd(saved.positionMs, saved.durationMs) ? 0 : saved.positionMs;

  return { playable, resumePositionMs };
};

/** Records a new session for `chosen` and signs its token. */
export const openSession = async (
  ctx: MutationCtx,
  viewer: Viewer,
  opening: {
    readonly args: {
      readonly profileId: Id<"profiles">;
      readonly deviceId: string;
      readonly deviceName?: string;
    };
    readonly chosen: Chosen;
    readonly roomId: Id<"rooms"> | null;
    readonly purpose: "download" | undefined;
    readonly now: number;
  },
): Promise<Infer<typeof startedPlayback>> => {
  const { args, chosen, now } = opening;
  const { playable, resumePositionMs } = chosen;
  const episodeId = playable.episode?._id ?? null;

  const fields = {
    userId: viewer.userId,
    profileId: args.profileId,
    authSessionId: viewer.session._id,
    deviceId: args.deviceId,
    deviceName:
      args.deviceName === undefined ? null : checkDisplayName(args.deviceName, "Device names"),
    titleId: playable.title._id,
    episodeId,
    fileId: playable.file._id,
    roomId: opening.roomId,
    mode: null,
    status: "active",
    state: "paused",
    positionMs: resumePositionMs,
    startedAt: now,
    lastReportAt: now,
    endedAt: null,
  } as const;

  const sessionId = await ctx.db.insert(
    "playbackSessions",
    opening.purpose === undefined ? fields : { ...fields, purpose: opening.purpose },
  );

  const session = await ctx.db.get(sessionId);

  if (session === null)
    return fail("internal", "The playback session vanished right after it was created");
  const { token, tokenExpiresAt } = await issueToken(session);

  return {
    sessionId,
    titleId: playable.title._id,
    episodeId,
    episode:
      playable.episode === null
        ? null
        : await presentEpisodeFor(ctx, args.profileId, playable.episode),
    file: presentMediaFile(playable.file),
    token,
    tokenExpiresAt,
    mediaBaseUrl: mediaBaseUrl(),
    resumePositionMs,
  };
};
