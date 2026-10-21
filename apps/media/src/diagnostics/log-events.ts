/**
 * Names of the log records playback diagnostics read. The service logs them with these messages
 * and session fields (`sessionId`, `userId`, `streamId`); the timeline (`timeline.ts`) matches
 * them by name, so renaming one here renames it on both sides.
 */
import type { PlaybackGrant } from "../playback/playback-token.ts";

/** Log messages of playback events. */
export const LogEvent = {
  streamStarted: "Stream.started",
  streamMoved: "Stream.moved",
  streamEnded: "Stream.ended",
  modeChanged: "Stream.mode_changed",
  encoderFailed: "StreamSessions.encoder_failed",
  segmentServed: "MediaRoutes.segment",
  slowSegment: "MediaRoutes.slow_segment",
  requestFailed: "MediaRoutes.request_failed",
  playerAttached: "Player.attached",
  bufferingStarted: "Player.buffering_started",
  bufferingEnded: "Player.buffering_ended",
  playerError: "Player.error",
  droppedFrames: "Player.dropped_frames",
  fragmentLoaded: "Player.fragment_loaded",
  recovery: "Player.recovery",
} as const;

/** A log message of a playback event. */
export type LogEvent = (typeof LogEvent)[keyof typeof LogEvent];

/** A request, segment load, or stall at least this long is slow and logs at `WARN`. */
export const SLOW_MS = 1000;

/** The session fields of a verified playback grant, for a record's annotations. */
export const grantAnnotations = (grant: Pick<PlaybackGrant, "sessionId" | "userId">) => ({
  sessionId: grant.sessionId,
  userId: grant.userId,
});
