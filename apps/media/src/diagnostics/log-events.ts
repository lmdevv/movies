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
  requestAfterSessionEnded: "MediaRoutes.request_after_session_ended",
  requestFailuresSuppressed: "MediaRoutes.request_failures_suppressed",
  playerAttached: "Player.attached",
  startupEnded: "Player.startup_ended",
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

/** A wait at least this long for a playback session to start playing logs at `WARN`. */
export const SLOW_STARTUP_MS = 5000;

/** The session fields of a verified playback grant, for a record's annotations. */
export const grantAnnotations = (grant: Pick<PlaybackGrant, "sessionId" | "userId">) => ({
  sessionId: grant.sessionId,
  userId: grant.userId,
});
