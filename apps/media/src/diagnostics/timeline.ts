/**
 * Playback diagnostics from retained log records: the timeline of one session, and the sessions
 * the log mentions. A table maps each playback event name (`log-events.ts`) to its timeline kind
 * and one-line summary; records under other names are left out. Evidence the records cannot hold
 * is named in `missing` rather than left blank, and audio/video drift, which no player reports,
 * is always "not measured".
 */
import {
  atLeast,
  type ClientPlatform,
  type DiagnosedSession,
  type DiagnosticsCounts,
  type LogRecord,
  type PlaybackDiagnostics,
  type TimelineEntry,
  type TimelineKind,
} from "@movies/contracts/diagnostics";
import { PlaybackSessionId, UserId } from "@movies/contracts/ids";
import { EpochMillis } from "@movies/contracts/units";
import { Option, Predicate, type Schema } from "effect";

import { LogEvent, SLOW_MS } from "./log-events.ts";

type Annotations = LogRecord["annotations"];

/** How one playback event becomes a timeline entry. */
interface Rule {
  readonly kind: TimelineKind;
  readonly source: TimelineEntry["source"];
  readonly summary: (fields: Annotations) => string;
  /** Whether the record belongs on the timeline; every record when absent. */
  readonly keep?: (fields: Annotations) => boolean;
}

const text = (value: Schema.Json | undefined): string =>
  value === undefined || value === null
    ? "?"
    : Predicate.isString(value)
      ? value
      : JSON.stringify(value);

const number = (value: Schema.Json | undefined): number => (Predicate.isNumber(value) ? value : 0);

/** `1234` milliseconds as `1.2 s`, `87` as `87 ms`. */
const duration = (value: Schema.Json | undefined): string => {
  const ms = number(value);

  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${String(Math.round(ms))} ms`;
};

const pad = (part: number): string => String(part).padStart(2, "0");

/** A media position as `h:mm:ss`. */
const position = (value: Schema.Json | undefined): string => {
  const total = Math.max(0, Math.floor(number(value)));

  return `${String(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
};

const STREAM_END_REASONS = new Map([
  ["idle", "no requests for STREAM_IDLE_SECONDS, so the service closed it"],
  ["replaced", "a newer negotiation on the same device replaced it"],
  ["stopped", "the player stopped it"],
  ["abandoned", "the player went away before the first segment"],
  ["failed", "the encoder failed"],
  ["shutdown", "the media service shut down"],
  ["session-ended", "the playback session ended"],
]);

/** Timeline rules by log message. */
const RULES = new Map<string, Rule>([
  [
    LogEvent.streamStarted,
    {
      kind: "stream-started",
      source: "server",
      summary: (fields) =>
        Predicate.isString(fields["streamId"])
          ? `HLS stream started (${text(fields["mode"])})`
          : `Direct play (${text(fields["mode"])})`,
    },
  ],
  [
    LogEvent.streamMoved,
    {
      kind: "stream-moved",
      source: "server",
      summary: (fields) =>
        `Encoder restarted at ${position(fields["fromSeconds"])} (generation ${text(fields["generation"])})`,
    },
  ],
  [
    LogEvent.streamEnded,
    {
      kind: "stream-ended",
      source: "server",
      summary: (fields) => {
        const reason = text(fields["reason"]);

        const why = STREAM_END_REASONS.get(reason);

        return `Stream ended: ${reason}${why === undefined ? "" : `, ${why}`}`;
      },
    },
  ],
  [
    LogEvent.modeChanged,
    {
      kind: "mode-changed",
      source: "server",
      summary: (fields) =>
        `Switched from ${text(fields["from"])} to ${text(fields["to"])}: ${text(fields["reason"])}`,
    },
  ],
  [
    LogEvent.encoderFailed,
    {
      kind: "encoder-failed",
      source: "server",
      summary: (fields) => `Encoder failed in ${text(fields["mode"])}`,
    },
  ],
  [
    LogEvent.slowSegment,
    {
      kind: "slow-segment",
      source: "server",
      summary: (fields) =>
        `Segment ${text(fields["segment"])} took ${duration(fields["elapsedMs"])}: encoder ${duration(fields["encoderWaitMs"])}, disk ${duration(fields["diskReadMs"])}, network ${duration(fields["networkWriteMs"])}${fields["completed"] === false ? ", cut off by the player" : ""}`,
    },
  ],
  [
    LogEvent.requestFailed,
    {
      kind: "request-failed",
      source: "server",
      summary: (fields) =>
        `${text(fields["route"])} request failed with ${text(fields["status"])}${Predicate.isString(fields["error"]) ? `: ${fields["error"]}` : ""}`,
    },
  ],
  [
    LogEvent.playerAttached,
    {
      kind: "player-attached",
      source: "player",
      summary: (fields) =>
        `Player attached: ${text(fields["engine"])} on ${text(fields["platform"])}, ${text(fields["mode"])}`,
    },
  ],
  [
    LogEvent.bufferingStarted,
    {
      kind: "buffering-started",
      source: "player",
      summary: (fields) =>
        `Buffering at ${position(fields["positionSeconds"])} with ${number(fields["bufferedAheadSeconds"]).toFixed(1)} s buffered ahead`,
    },
  ],
  [
    LogEvent.bufferingEnded,
    {
      kind: "buffering-ended",
      source: "player",
      summary: (fields) =>
        `Stalled ${duration(fields["stalledMs"])}, then ${fields["endedBy"] === "paused" ? "paused by the viewer" : "playing again"}`,
    },
  ],
  [
    LogEvent.playerError,
    {
      kind: "player-error",
      source: "player",
      summary: (fields) =>
        `${text(fields["errorSource"])} ${fields["fatal"] === true ? "fatal " : ""}error ${text(fields["kind"])}${Predicate.isNumber(fields["status"]) ? ` (HTTP ${text(fields["status"])})` : ""}: ${text(fields["detail"])}`,
    },
  ],
  [
    LogEvent.droppedFrames,
    {
      kind: "dropped-frames",
      source: "player",
      summary: (fields) =>
        `Dropped ${text(fields["dropped"])} of ${text(fields["decoded"])} frames`,
    },
  ],
  [
    LogEvent.fragmentLoaded,
    {
      kind: "slow-fragment",
      source: "player",
      keep: (fields) => number(fields["elapsedMs"]) >= SLOW_MS,
      summary: (fields) =>
        `Segment ${text(fields["segment"])} loaded in ${duration(fields["elapsedMs"])}, first byte after ${duration(fields["firstByteMs"])}`,
    },
  ],
  [
    LogEvent.recovery,
    {
      kind: "recovery",
      source: "player",
      summary: (fields) => `Recovery: ${text(fields["action"])} (${text(fields["reason"])})`,
    },
  ],
]);

/** Annotations that identify the session rather than describe the event. */
const IDENTITY_FIELDS: ReadonlySet<string> = new Set([
  "sessionId",
  "userId",
  "source",
  "occurredAt",
  "streamId",
]);

/** When a record's event happened: a player's `occurredAt`, else when it was logged. */
const occurredAt = (record: LogRecord): Option.Option<number> => {
  const reported = record.annotations["occurredAt"];
  const time = Date.parse(Predicate.isString(reported) ? reported : record.timestamp);

  return Number.isNaN(time) ? Option.none() : Option.some(time);
};

const messageOf = (record: LogRecord): string =>
  Predicate.isString(record.message) ? record.message : "";

/** The timeline entry of `record`, when it records a playback event. */
const entryOf = (record: LogRecord): Option.Option<TimelineEntry> => {
  const rule = RULES.get(messageOf(record));
  const fields = record.annotations;

  if (rule === undefined || (rule.keep !== undefined && !rule.keep(fields))) return Option.none();

  return Option.map(occurredAt(record), (at) => ({
    at: EpochMillis.make(at),
    source: rule.source,
    kind: rule.kind,
    level: record.level,
    streamId: Predicate.isString(fields["streamId"]) ? fields["streamId"] : null,
    summary: rule.summary(fields),
    details: Object.fromEntries(
      Object.entries(fields).filter(([key]) => !IDENTITY_FIELDS.has(key)),
    ),
  }));
};

const countOf = (entries: ReadonlyArray<TimelineEntry>, kind: TimelineKind): number =>
  entries.filter((entry) => entry.kind === kind).length;

const sumOf = (entries: ReadonlyArray<TimelineEntry>, kind: TimelineKind, field: string): number =>
  entries
    .filter((entry) => entry.kind === kind)
    .reduce((total, entry) => total + number(entry.details[field]), 0);

const countsOf = (entries: ReadonlyArray<TimelineEntry>): DiagnosticsCounts => ({
  streams: countOf(entries, "stream-started"),
  stalls: countOf(entries, "buffering-started"),
  stalledMs: sumOf(entries, "buffering-ended", "stalledMs"),
  slowSegments: countOf(entries, "slow-segment"),
  failedRequests: countOf(entries, "request-failed"),
  playerErrors: countOf(entries, "player-error"),
  recoveries: countOf(entries, "recovery"),
  slowFragments: countOf(entries, "slow-fragment"),
  droppedFrames: sumOf(entries, "dropped-frames", "dropped"),
});

const isPlatform = (value: Schema.Json | undefined): value is ClientPlatform =>
  value === "web" || value === "ios";

const platformOf = (records: ReadonlyArray<LogRecord>): ClientPlatform | null =>
  records.map((record) => record.annotations["platform"]).find(isPlatform) ?? null;

/** The gaps in what `entries` can tell. */
const missingEvidence = (
  entries: ReadonlyArray<TimelineEntry>,
  platform: ClientPlatform | null,
  truncated: boolean,
): ReadonlyArray<string> => {
  const fromPlayer = entries.some((entry) => entry.source === "player");

  const engines = new Set(
    entries.flatMap((entry) =>
      entry.kind === "player-attached" ? [text(entry.details["engine"])] : [],
    ),
  );

  const direct = entries.some(
    (entry) => entry.kind === "stream-started" && entry.streamId === null,
  );

  return [
    ...(truncated
      ? [
          "Only the latest records fit in one timeline; earlier events of this session are left out.",
        ]
      : []),
    ...(entries.some((entry) => entry.kind === "stream-started")
      ? []
      : [
          "No stream started in the retained logs: the session began before the oldest log file (LOG_RETENTION_DAYS) or never reached this media service.",
        ]),
    ...(fromPlayer
      ? []
      : [
          "The player sent no diagnostics: an app from before diagnostics, a player that does not report them (mpv or VLC through movies play), or events lost on the way. Stalls and player errors are unknown.",
        ]),
    ...(direct
      ? ["Direct play serves byte ranges, which are not timed; only failed requests show."]
      : []),
    ...(fromPlayer && !engines.has("hls.js")
      ? ["Segment load times come from hls.js only; this player does not report them."]
      : []),
    ...(platform === "ios" ? ["Dropped frames: AVPlayer does not report them."] : []),
  ];
};

const DRIFT_REASON =
  "No player reports audio/video sync, so drift is not measured. Stalls, dropped frames, encoder restarts, and stream changes around the time it was noticed are the evidence available.";

/**
 * The timeline of session `sessionId` from its records, oldest first; none when no record names a
 * playback event. `truncated` says the records are only the latest of more.
 */
export const timelineOf = (
  sessionId: PlaybackSessionId,
  records: ReadonlyArray<LogRecord>,
  truncated: boolean,
): Option.Option<PlaybackDiagnostics> => {
  const entries = records
    .flatMap((record) => Option.toArray(entryOf(record)))
    .toSorted((left, right) => left.at - right.at);

  const first = entries[0];
  const last = entries.at(-1);

  if (first === undefined || last === undefined) return Option.none();
  const platform = platformOf(records);

  return Option.some({
    sessionId,
    firstSeenAt: first.at,
    lastSeenAt: last.at,
    platform,
    counts: countsOf(entries),
    drift: { status: "not-measured", reason: DRIFT_REASON },
    missing: missingEvidence(entries, platform, truncated),
    truncated,
    entries,
  });
};

/** The accounts `records` name, from their `userId` annotations. */
export const ownersOf = (records: ReadonlyArray<LogRecord>): ReadonlySet<string> =>
  new Set(
    records.flatMap((record) => {
      const userId = record.annotations["userId"];

      return Predicate.isString(userId) ? [userId] : [];
    }),
  );

/** The playback sessions `records` mention, most recently seen first. */
export const sessionsOf = (records: ReadonlyArray<LogRecord>): ReadonlyArray<DiagnosedSession> => {
  const sessions = new Map<string, DiagnosedSession>();

  for (const record of records) {
    const sessionId = record.annotations["sessionId"];
    const at = occurredAt(record);

    if (!Predicate.isString(sessionId) || Option.isNone(at)) continue;
    const userId = record.annotations["userId"];
    const platform = record.annotations["platform"];
    const seen = sessions.get(sessionId);
    const warning = atLeast(record.level, "WARN") ? 1 : 0;

    sessions.set(sessionId, {
      sessionId: PlaybackSessionId.make(sessionId),
      userId: seen?.userId ?? (Predicate.isString(userId) ? UserId.make(userId) : null),
      firstSeenAt: EpochMillis.make(Math.min(seen?.firstSeenAt ?? at.value, at.value)),
      lastSeenAt: EpochMillis.make(Math.max(seen?.lastSeenAt ?? at.value, at.value)),
      platform: seen?.platform ?? (isPlatform(platform) ? platform : null),
      warnings: (seen?.warnings ?? 0) + warning,
    });
  }

  return [...sessions.values()].toSorted((left, right) => right.lastSeenAt - left.lastSeenAt);
};
