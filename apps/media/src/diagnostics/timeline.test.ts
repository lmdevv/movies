import type { LogLevel, LogRecord } from "@movies/contracts/diagnostics";
import { PlaybackSessionId } from "@movies/contracts/ids";
import { Option } from "effect";
import { assert, describe, it } from "vitest";

import { LogEvent } from "./log-events.ts";
import { ownersOf, sessionsOf, timelineOf } from "./timeline.ts";

const BASE = Date.UTC(2026, 9, 21, 20);

const SESSION = PlaybackSessionId.make("session_a");

const record = (
  message: string,
  offsetMs: number,
  annotations: LogRecord["annotations"],
  level: LogLevel = "INFO",
): LogRecord => ({
  message,
  level,
  timestamp: new Date(BASE + offsetMs).toISOString(),
  annotations: { sessionId: SESSION, userId: "user_a", ...annotations },
});

/** A player record logged at `loggedMs` about an event at `occurredMs`. */
const player = (
  message: string,
  loggedMs: number,
  occurredMs: number,
  annotations: LogRecord["annotations"],
  level: LogLevel = "INFO",
): LogRecord =>
  record(
    message,
    loggedMs,
    {
      source: "player",
      platform: "web",
      occurredAt: new Date(BASE + occurredMs).toISOString(),
      ...annotations,
    },
    level,
  );

const RECORDS: ReadonlyArray<LogRecord> = [
  record(LogEvent.streamStarted, 0, { streamId: "s1", mode: "remux" }),
  player(LogEvent.playerAttached, 5000, 100, { streamId: "s1", mode: "remux", engine: "hls.js" }),
  record(
    LogEvent.slowSegment,
    40_000,
    {
      streamId: "s1",
      segment: 12,
      elapsedMs: 32_900,
      encoderWaitMs: 31_000,
      diskReadMs: 3,
      networkWriteMs: 1897,
      completed: true,
    },
    "WARN",
  ),
  player(LogEvent.bufferingStarted, 45_000, 10_000, {
    streamId: "s1",
    positionSeconds: 70,
    bufferedAheadSeconds: 0,
  }),
  player(
    LogEvent.bufferingEnded,
    45_000,
    41_000,
    { streamId: "s1", positionSeconds: 70, bufferedAheadSeconds: 4, stalledMs: 31_000 },
    "WARN",
  ),
  player(
    LogEvent.fragmentLoaded,
    45_000,
    40_500,
    { streamId: "s1", segment: 12, elapsedMs: 30_400, firstByteMs: 30_000, bytes: 1_000_000 },
    "WARN",
  ),
  player(LogEvent.fragmentLoaded, 45_000, 41_500, {
    streamId: "s1",
    segment: 13,
    elapsedMs: 90,
    firstByteMs: 20,
    bytes: 1_000_000,
  }),
  player(
    LogEvent.recovery,
    50_000,
    49_000,
    { action: "renegotiate", reason: "StreamNotFound" },
    "WARN",
  ),
  record(
    LogEvent.requestFailed,
    48_000,
    { route: "hls", status: 404, error: "StreamNotFound", streamId: "s1" },
    "WARN",
  ),
  record(LogEvent.streamEnded, 47_000, { streamId: "s1", reason: "idle" }),
  record("Sent HTTP response", 47_500, {}),
];

describe("playback timeline", () => {
  const timeline = Option.getOrThrow(timelineOf(SESSION, RECORDS, false));

  it("orders events by when they happened, not when they were logged", () => {
    assert.deepStrictEqual(
      timeline.entries.map((entry) => entry.kind),
      [
        "stream-started",
        "player-attached",
        "buffering-started",
        "slow-segment",
        "slow-fragment",
        "buffering-ended",
        "stream-ended",
        "request-failed",
        "recovery",
      ],
    );
  });

  it("splits a slow segment's time and says why a stream ended", () => {
    const slow = timeline.entries.find((entry) => entry.kind === "slow-segment");
    const ended = timeline.entries.find((entry) => entry.kind === "stream-ended");

    assert.strictEqual(
      slow?.summary,
      "Segment 12 took 32.9 s: encoder 31.0 s, disk 3 ms, network 1.9 s",
    );
    assert.include(ended?.summary, "STREAM_IDLE_SECONDS");
    assert.strictEqual(slow?.details["encoderWaitMs"], 31_000);
    assert.isUndefined(slow?.details["userId"]);
  });

  it("totals stalls, slow loads, failures, and recoveries", () => {
    assert.deepStrictEqual(timeline.counts, {
      streams: 1,
      stalls: 1,
      stalledMs: 31_000,
      slowSegments: 1,
      failedRequests: 1,
      playerErrors: 0,
      recoveries: 1,
      slowFragments: 1,
      droppedFrames: 0,
    });
    assert.strictEqual(timeline.platform, "web");
  });

  it("never measures drift and names no gap when both sides reported", () => {
    assert.strictEqual(timeline.drift.status, "not-measured");
    assert.deepStrictEqual(timeline.missing, []);
  });

  it("names the evidence a session without player reports lacks", () => {
    const serverOnly = Option.getOrThrow(
      timelineOf(
        SESSION,
        RECORDS.filter((entry) => entry.annotations["source"] !== "player"),
        true,
      ),
    );

    assert.isTrue(serverOnly.truncated);
    assert.isTrue(serverOnly.missing.some((gap) => gap.includes("player sent no diagnostics")));
    assert.isTrue(serverOnly.missing.some((gap) => gap.includes("latest records")));
  });

  it("is none for records without playback events", () => {
    assert.isTrue(Option.isNone(timelineOf(SESSION, [record("Sent HTTP response", 0, {})], false)));
  });
});

describe("diagnosed sessions", () => {
  it("names the accounts the records belong to", () => {
    assert.deepStrictEqual([...ownersOf(RECORDS)], ["user_a"]);
  });

  it("lists sessions newest first with their warnings", () => {
    const other: LogRecord = {
      message: LogEvent.streamStarted,
      level: "INFO",
      timestamp: new Date(BASE + 90_000).toISOString(),
      annotations: { sessionId: "session_b", userId: "user_b" },
    };

    const sessions = sessionsOf([...RECORDS, other]);

    assert.deepStrictEqual(
      sessions.map(
        (session) => `${session.sessionId} ${String(session.userId)} ${String(session.warnings)}`,
      ),
      ["session_b user_b 0", "session_a user_a 5"],
    );
    assert.strictEqual(sessions[1]?.platform, "web");
  });
});
