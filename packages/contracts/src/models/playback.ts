/** Per-device playback sessions and the tokens that authorize media requests. */
import { Schema } from "effect";

import { DeviceId, EpisodeId, MediaFileId, PlaybackSessionId, ProfileId, TitleId } from "../ids";
import { EpochMillis, Milliseconds } from "../units";
import { MediaFile } from "./catalog";

/** How the media service delivers a session's file to its device. */
export const PlaybackMode = Schema.Literals([
  "direct",
  "remux",
  "transcode-qsv",
  "transcode-software",
]);

/** How a session's file reaches its device. */
export type PlaybackMode = typeof PlaybackMode.Type;

/** A device's playback, as other devices of the account see it. */
export const PlaybackSession = Schema.Struct({
  id: PlaybackSessionId,
  profileId: ProfileId,
  deviceId: DeviceId,
  deviceName: Schema.NullOr(Schema.String),
  titleId: TitleId,
  episodeId: Schema.NullOr(EpisodeId),
  fileId: MediaFileId,
  mode: Schema.NullOr(PlaybackMode),
  positionMs: Milliseconds,
  state: Schema.Literals(["playing", "paused"]),
  startedAt: EpochMillis,
  lastReportAt: EpochMillis,
});

/** A device's playback. */
export interface PlaybackSession extends Schema.Schema.Type<typeof PlaybackSession> {}

/**
 * A new playback session. Send `token` to the media service in the `token` query parameter; it
 * expires at `tokenExpiresAt` (six hours) and `playback.renewToken` issues a fresh one.
 */
export const StartedPlayback = Schema.Struct({
  sessionId: PlaybackSessionId,
  titleId: TitleId,
  episodeId: Schema.NullOr(EpisodeId),
  file: MediaFile,
  token: Schema.String,
  tokenExpiresAt: EpochMillis,
  mediaBaseUrl: Schema.String,
  /** Where to start: saved progress, or zero when finished or never started. Rooms ignore it. */
  resumePositionMs: Milliseconds,
});

/** A new playback session. */
export interface StartedPlayback extends Schema.Schema.Type<typeof StartedPlayback> {}

/** A fresh playback token for an active session. */
export const RenewedToken = Schema.Struct({
  token: Schema.String,
  tokenExpiresAt: EpochMillis,
});

/** A fresh playback token. */
export interface RenewedToken extends Schema.Schema.Type<typeof RenewedToken> {}

/**
 * Why a device reports progress: the periodic `tick` (about every ten seconds), a `pause`,
 * `resume`, or `seek`, or `ended` when playback reached the end of the file.
 */
export const ProgressEvent = Schema.Literals(["tick", "pause", "resume", "seek", "ended"]);

/** Why a device reports progress. */
export type ProgressEvent = typeof ProgressEvent.Type;

/**
 * Outcome of a progress report. `applied` is false when a newer session of the same profile owns
 * the item's progress, so this stale device did not overwrite it.
 */
export const ProgressReceipt = Schema.Struct({
  applied: Schema.Boolean,
  watched: Schema.Boolean,
});

/** Outcome of a progress report. */
export interface ProgressReceipt extends Schema.Schema.Type<typeof ProgressReceipt> {}
