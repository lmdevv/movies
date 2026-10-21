/**
 * Retained service logs and playback diagnostics as data.
 *
 * The media service writes every log line it prints, already redacted, to rotating NDJSON files
 * (`LogRecord`). Admins read them back through `POST /api/logs` (`LogQuery`), which answers with
 * NDJSON, one record per line, and keeps the connection open with `follow`. Players report what
 * they see (stalls, errors, segment loads, recoveries) in batches of `ClientDiagnosticEvent`
 * through `POST /api/playback/diagnostics`, authenticated by their playback token; the service
 * writes them into the same log. `PlaybackDiagnostics` is the timeline of one playback session
 * that the service assembles from those records.
 */
import { Schema } from "effect";

import { PlaybackSessionId, UserId } from "./ids";
import { StreamId } from "./media-playback";
import { PlaybackMode } from "./models/playback";
import { PlaybackTokenInvalid } from "./playback-token";
import { EpochMillis } from "./units";

/** Paths of the log and diagnostics routes, relative to the media service's base URL. */
export const DIAGNOSTICS_ROUTES = {
  logs: "/api/logs",
  clientEvents: "/api/playback/diagnostics",
} as const;

/** A log level as a record carries it. */
export const LogLevel = Schema.Literals(["TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL"]);

/** A log level as a record carries it. */
export type LogLevel = typeof LogLevel.Type;

/** Every level from least to most severe. */
export const LOG_LEVELS: ReadonlyArray<LogLevel> = LogLevel.literals;

/** Whether `level` is at least as severe as `minimum`. */
export const atLeast = (level: LogLevel, minimum: LogLevel): boolean =>
  LOG_LEVELS.indexOf(level) >= LOG_LEVELS.indexOf(minimum);

/**
 * One retained log line: Effect's structured log format. `message` is the event name, such as
 * `MediaRoutes.slow_segment`; `annotations` carry its fields, such as `sessionId` and `streamId`.
 */
export const LogRecord = Schema.Struct({
  /** ISO 8601 time the line was logged. */
  timestamp: Schema.String,
  level: LogLevel,
  message: Schema.Json,
  annotations: Schema.Record(Schema.String, Schema.Json),
  spans: Schema.optional(Schema.Record(Schema.String, Schema.Finite)),
  cause: Schema.optional(Schema.String),
  fiberId: Schema.optional(Schema.String),
});

/** One retained log line. */
export interface LogRecord extends Schema.Schema.Type<typeof LogRecord> {}

/** The most records one request returns before following. */
export const MAX_LOG_LIMIT = 5000;

/**
 * Which retained records to read. Every filter given must match. Without `follow` the answer is
 * the last `limit` matching records in time order; with it, the same and then each new matching
 * record as it is logged, until the client disconnects.
 */
export const LogQuery = Schema.Struct({
  /** Records at or after this instant. */
  since: Schema.optional(EpochMillis),
  /** Records before this instant; not allowed with `follow`. */
  until: Schema.optional(EpochMillis),
  /** The least severe level returned. */
  level: Schema.optional(LogLevel),
  sessionId: Schema.optional(PlaybackSessionId),
  streamId: Schema.optional(Schema.String),
  /** Only timed requests and segment loads that took at least this many milliseconds. */
  slowMs: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  /** Case-insensitive text the record's JSON line contains. */
  grep: Schema.optional(Schema.String.check(Schema.isBetweenLength(1, 200))),
  limit: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_LOG_LIMIT })),
  ),
  follow: Schema.optional(Schema.Boolean),
});

/** Which retained records to read. */
export interface LogQuery extends Schema.Schema.Type<typeof LogQuery> {}

/**
 * Response header that is `true` when earlier records may match too: `limit` was reached before
 * the oldest file. Narrow the query or raise the limit to see them.
 */
export const LOG_TRUNCATED_HEADER = "x-movies-log-truncated";

/** How long before sending the batch an event happened, in milliseconds; at most ten minutes. */
const AgeMs = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 600_000 }));

const Seconds = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** How a player plays the stream. */
export const PlayerEngine = Schema.Literals(["hls.js", "html-video", "avplayer"]);

/** How a player plays the stream. */
export type PlayerEngine = typeof PlayerEngine.Type;

/** What a player did to get playing again, or the recovery the SDK chose. */
export const RecoveryAction = Schema.Literals([
  "reload-playlist",
  "renegotiate",
  "renew-token",
  "new-session",
  "retry-later",
  "try-another-way",
  "media-error-recovery",
]);

/** What a player did to get playing again. */
export type RecoveryAction = typeof RecoveryAction.Type;

/** Something a player saw. */
export const PlayerObservation = Schema.TaggedUnion({
  /** A stream was attached to the player. */
  Attached: { mode: PlaybackMode, engine: PlayerEngine },
  /** Playback stopped to wait for data while the viewer wanted it to play. */
  BufferingStarted: { positionSeconds: Seconds, bufferedAheadSeconds: Seconds },
  /** Playback went on after a stall, or the viewer paused instead. */
  BufferingEnded: {
    positionSeconds: Seconds,
    bufferedAheadSeconds: Seconds,
    durationMs: Count,
    endedBy: Schema.Literals(["playing", "paused"]),
  },
  /** A media, decoder, or network error the player reported. */
  PlayerError: {
    source: Schema.Literals(["html-video", "hls.js", "avplayer"]),
    kind: Schema.String.check(Schema.isBetweenLength(1, 64)),
    detail: Schema.String.check(Schema.isMaxLength(300)),
    fatal: Schema.Boolean,
    status: Schema.optional(Schema.Int),
  },
  /** Frames the decoder dropped since the previous report, out of those it decoded. */
  DroppedFrames: { dropped: Count, decoded: Count },
  /** hls.js finished loading one segment. */
  FragmentLoaded: { segment: Count, durationMs: Count, firstByteMs: Count, bytes: Count },
  /** The player recovered, or tried to, from a failure. */
  Recovery: { action: RecoveryAction, reason: Schema.String.check(Schema.isMaxLength(120)) },
});

/** Something a player saw. */
export type PlayerObservation = typeof PlayerObservation.Type;

/** An observation as a batch carries it: how long before the batch, and in which stream. */
export const ClientDiagnosticEvent = Schema.Struct({
  ageMs: AgeMs,
  /** The HLS stream playing, absent for direct play. */
  streamId: Schema.optional(StreamId),
  observation: PlayerObservation,
});

/** An observation as a batch carries it. */
export interface ClientDiagnosticEvent extends Schema.Schema.Type<typeof ClientDiagnosticEvent> {}

/** The most events one batch may carry. */
export const MAX_CLIENT_EVENTS = 100;

/** The platform a player runs on. */
export const ClientPlatform = Schema.Literals(["web", "ios"]);

/** The platform a player runs on. */
export type ClientPlatform = typeof ClientPlatform.Type;

/** A batch of a player's events for the session its playback token names. */
export const ClientDiagnosticsRequest = Schema.Struct({
  /** The session's playback token; a session that has ended still accepts its last events. */
  token: Schema.Redacted(Schema.String),
  platform: ClientPlatform,
  events: Schema.Array(ClientDiagnosticEvent).check(Schema.isBetweenLength(1, MAX_CLIENT_EVENTS)),
});

/** A batch of a player's events. */
export interface ClientDiagnosticsRequest extends Schema.Schema.Type<
  typeof ClientDiagnosticsRequest
> {}

/** The session sent more events than the service keeps. Drop the batch. */
export class DiagnosticsRateLimited extends Schema.TaggedError<DiagnosticsRateLimited>()(
  "DiagnosticsRateLimited",
  { retryAfterSeconds: Schema.Int },
  { httpApiStatus: 429 },
) {
  override get message(): string {
    return `Diagnostics rate limited: retry after ${this.retryAfterSeconds} s`;
  }
}

/** Failures of `POST /api/playback/diagnostics`. */
export const ClientDiagnosticsErrors = [PlaybackTokenInvalid, DiagnosticsRateLimited] as const;

/** What a timeline entry records. */
export const TimelineKind = Schema.Literals([
  "stream-started",
  "stream-moved",
  "stream-ended",
  "mode-changed",
  "encoder-failed",
  "slow-segment",
  "request-failed",
  "player-attached",
  "buffering-started",
  "buffering-ended",
  "player-error",
  "dropped-frames",
  "slow-fragment",
  "recovery",
]);

/** What a timeline entry records. */
export type TimelineKind = typeof TimelineKind.Type;

/** One thing that happened to a playback session, from the service's or the player's side. */
export const TimelineEntry = Schema.Struct({
  at: EpochMillis,
  source: Schema.Literals(["server", "player"]),
  kind: TimelineKind,
  level: LogLevel,
  streamId: Schema.NullOr(Schema.String),
  /** One line for people. */
  summary: Schema.String,
  /** The record's fields, such as the latency split of a slow segment. */
  details: Schema.Record(Schema.String, Schema.Json),
});

/** One thing that happened to a playback session. */
export interface TimelineEntry extends Schema.Schema.Type<typeof TimelineEntry> {}

/** Totals over a session's timeline. */
export const DiagnosticsCounts = Schema.Struct({
  streams: Count,
  stalls: Count,
  stalledMs: Count,
  slowSegments: Count,
  failedRequests: Count,
  playerErrors: Count,
  recoveries: Count,
  slowFragments: Count,
  droppedFrames: Count,
});

/** Totals over a session's timeline. */
export interface DiagnosticsCounts extends Schema.Schema.Type<typeof DiagnosticsCounts> {}

/** A measurement the timeline cannot give, and why. */
const NotMeasured = Schema.Struct({
  status: Schema.Literal("not-measured"),
  reason: Schema.String,
});

/**
 * The timeline of one playback session from the retained logs. `missing` names evidence the logs
 * do not hold, so an empty part of the timeline is never mistaken for a clean one.
 */
export const PlaybackDiagnostics = Schema.Struct({
  sessionId: PlaybackSessionId,
  firstSeenAt: EpochMillis,
  lastSeenAt: EpochMillis,
  platform: Schema.NullOr(ClientPlatform),
  counts: DiagnosticsCounts,
  /** Audio/video drift: no player reports it, so it is never guessed. */
  drift: NotMeasured,
  missing: Schema.Array(Schema.String),
  /** More records matched than one timeline holds; the earliest were left out. */
  truncated: Schema.Boolean,
  entries: Schema.Array(TimelineEntry),
});

/** The timeline of one playback session. */
export interface PlaybackDiagnostics extends Schema.Schema.Type<typeof PlaybackDiagnostics> {}

/** A playback session the retained logs mention, to find its ID. */
export const DiagnosedSession = Schema.Struct({
  sessionId: PlaybackSessionId,
  userId: Schema.NullOr(UserId),
  firstSeenAt: EpochMillis,
  lastSeenAt: EpochMillis,
  platform: Schema.NullOr(ClientPlatform),
  /** Records at `WARN` or above. */
  warnings: Count,
});

/** A playback session the retained logs mention. */
export interface DiagnosedSession extends Schema.Schema.Type<typeof DiagnosedSession> {}
