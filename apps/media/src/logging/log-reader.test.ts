import { NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import type { LogLevel, LogQuery } from "@movies/contracts/diagnostics";
import { PlaybackSessionId } from "@movies/contracts/ids";
import { EpochMillis } from "@movies/contracts/units";
import { Duration, Effect, FileSystem, Stream } from "effect";
import { TestClock } from "effect/testing";

import * as LogReader from "./log-reader.ts";
import * as RetainedLogs from "./retained-logs.ts";

const BASE = Date.UTC(2026, 9, 21, 12);

/** A log line as the logger writes it, `offsetMs` after `BASE`. */
const line = (
  message: string,
  offsetMs: number,
  level: LogLevel = "INFO",
  annotations: Readonly<Record<string, string | number>> = {},
): string =>
  JSON.stringify({
    message,
    level,
    timestamp: new Date(BASE + offsetMs).toISOString(),
    annotations,
    spans: {},
    fiberId: "#1",
  });

const SESSION = PlaybackSessionId.make("session_a");

/** Every line the tests write, in order. */
const LINES = [
  line("Main.started", 0),
  line("Stream.started", 1000, "INFO", { sessionId: SESSION, streamId: "s1", mode: "remux" }),
  line("MediaRoutes.slow_segment", 2000, "WARN", {
    sessionId: SESSION,
    streamId: "s1",
    elapsedMs: 32_900,
  }),
  line("MediaRoutes.segment", 3000, "DEBUG", { sessionId: SESSION, streamId: "s1", elapsedMs: 80 }),
  line("Stream.started", 4000, "INFO", { sessionId: "session_b", streamId: "s2", mode: "remux" }),
  line("Backups.failed", 5000, "ERROR", { detail: "token=abc.def disk full" }),
];

/** The messages `query` reads from a log holding `LINES`. */
const messages = (query: LogQuery) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "movies-logs-" });

    yield* TestClock.setTime(BASE);

    const logs = yield* RetainedLogs.make({
      directory,
      retention: { maxAgeMs: Duration.toMillis(Duration.days(14)), maxBytes: 1 << 29 },
    });

    for (const entry of LINES) logs.append(entry);
    yield* logs.flush;

    const found = yield* LogReader.read(query).pipe(
      Effect.provideService(RetainedLogs.Service, logs),
    );

    return {
      messages: found.matches.map((match) => match.record.message),
      truncated: found.truncated,
      lines: found.matches.map((match) => match.line),
      records: found.matches.map((match) => match.record),
    };
  }).pipe(Effect.scoped);

layer(NodeServices.layer)("log queries", (it) => {
  it.effect("reads everything in time order without filters", () =>
    Effect.gen(function* () {
      const read = yield* messages({});

      assert.strictEqual(read.messages.length, LINES.length);
      assert.isFalse(read.truncated);
    }),
  );

  it.effect("keeps the latest records up to the limit and says older ones may match", () =>
    Effect.gen(function* () {
      const read = yield* messages({ limit: 2 });

      assert.deepStrictEqual(read.messages, ["Stream.started", "Backups.failed"]);
      assert.isTrue(read.truncated);
    }),
  );

  it.effect("filters by level, session, stream, slowness, and text", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual((yield* messages({ level: "WARN" })).messages, [
        "MediaRoutes.slow_segment",
        "Backups.failed",
      ]);
      assert.deepStrictEqual((yield* messages({ sessionId: SESSION })).messages, [
        "Stream.started",
        "MediaRoutes.slow_segment",
        "MediaRoutes.segment",
      ]);
      assert.deepStrictEqual((yield* messages({ streamId: "s2" })).messages, ["Stream.started"]);
      assert.deepStrictEqual((yield* messages({ slowMs: 1000 })).messages, [
        "MediaRoutes.slow_segment",
      ]);
      assert.deepStrictEqual((yield* messages({ grep: "BACKUPS" })).messages, ["Backups.failed"]);
    }),
  );

  it.effect("reads the window from since up to until", () =>
    Effect.gen(function* () {
      const read = yield* messages({
        since: EpochMillis.make(BASE + 1000),
        until: EpochMillis.make(BASE + 3000),
      });

      assert.deepStrictEqual(read.messages, ["Stream.started", "MediaRoutes.slow_segment"]);
    }),
  );

  it.effect("redacts what it serves, and the records it hands on", () =>
    Effect.gen(function* () {
      const read = yield* messages({ grep: "disk full" });

      assert.notInclude(read.lines.join("\n"), "abc.def");
      assert.include(read.lines.join("\n"), "disk full");
      assert.deepStrictEqual(read.records[0]?.annotations, {
        detail: "token=<redacted> disk full",
      });
    }),
  );

  it.effect("never lets grep find what redaction hides", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual((yield* messages({ grep: "abc.def" })).messages, []);
    }),
  );

  it.effect("reads up to until a record logged just before its file began", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "movies-logs-" });

      yield* TestClock.setTime(BASE);

      const logs = yield* RetainedLogs.make({
        directory,
        retention: { maxAgeMs: Duration.toMillis(Duration.days(14)), maxBytes: 1 << 29 },
      });

      yield* TestClock.adjust(Duration.millis(100));
      logs.append(line("Stream.started", 100));
      yield* TestClock.adjust(Duration.millis(400));
      yield* logs.flush;

      const found = yield* LogReader.read({ until: EpochMillis.make(BASE + 200) }).pipe(
        Effect.provideService(RetainedLogs.Service, logs),
      );

      assert.deepStrictEqual(
        found.matches.map((match) => match.record.message),
        ["Stream.started"],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("follows: matching lines written after the query arrive live", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "movies-logs-" });

      yield* TestClock.setTime(BASE);

      const logs = yield* RetainedLogs.make({
        directory,
        retention: { maxAgeMs: Duration.toMillis(Duration.days(14)), maxBytes: 1 << 29 },
      });

      logs.append(line("Stream.started", 0, "INFO", { sessionId: SESSION }));

      const found = yield* LogReader.read({ sessionId: SESSION, follow: true }).pipe(
        Effect.provideService(RetainedLogs.Service, logs),
      );

      logs.append(line("Other.session", 10, "INFO", { sessionId: "session_b" }));
      logs.append(line("Stream.ended", 20, "INFO", { sessionId: SESSION }));
      yield* logs.flush;

      const live = yield* found.live.pipe(Stream.take(1), Stream.runCollect);

      assert.deepStrictEqual(
        found.matches.map((match) => match.record.message),
        ["Stream.started"],
      );
      assert.include(live[0], "Stream.ended");
    }).pipe(Effect.scoped),
  );
});

describe("log queries without a log", () => {
  layer(NodeServices.layer)((it) => {
    it.effect("finds nothing in an empty folder", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "movies-logs-" });

        const logs = yield* RetainedLogs.make({
          directory,
          retention: { maxAgeMs: 1, maxBytes: 1 },
        });

        const found = yield* LogReader.read({}).pipe(
          Effect.provideService(RetainedLogs.Service, logs),
        );

        assert.deepStrictEqual(found.matches, []);
        assert.isFalse(found.truncated);
      }).pipe(Effect.scoped),
    );
  });
});
