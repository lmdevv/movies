import { NodeServices } from "@effect/platform-node";
import { assert, layer } from "@effect/vitest";
import { Duration, Effect, FileSystem, Option, Path, PubSub } from "effect";
import { TestClock } from "effect/testing";

import { createdAtOf, fileName } from "./log-files.ts";
import * as RetainedLogs from "./retained-logs.ts";

const DAY = 86_400_000;

const MEBIBYTE = 1024 * 1024;

/** A writer over a fresh folder, with the clock at a real date. */
const writerIn = (maxBytes = 512 * MEBIBYTE) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "movies-logs-" });

    yield* TestClock.setTime(Date.UTC(2026, 9, 21, 12));

    const logs = yield* RetainedLogs.make({
      directory,
      retention: { maxAgeMs: 14 * DAY, maxBytes },
    });

    return { logs, directory };
  });

/** The lines of every log file in `directory`, oldest file first. */
const linesIn = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const names = (yield* fs.readDirectory(directory)).toSorted();

    return yield* Effect.forEach(names, (name) =>
      fs
        .readFileString(path.join(directory, name))
        .pipe(Effect.map((text) => ({ name, lines: text.split("\n").filter(Boolean) }))),
    );
  });

layer(NodeServices.layer)("retained log writer", (it) => {
  it.effect("appends lines to one file and starts another the next day", () =>
    Effect.gen(function* () {
      const { logs, directory } = yield* writerIn();

      logs.append('{"n":1}');
      logs.append('{"n":2}');
      yield* logs.flush;
      yield* TestClock.adjust(Duration.days(1));
      logs.append('{"n":3}');
      yield* logs.flush;

      const files = yield* linesIn(directory);

      assert.deepStrictEqual(
        files.map((entry) => entry.lines),
        [['{"n":1}', '{"n":2}'], ['{"n":3}']],
      );
      assert.isTrue(files.every((entry) => Option.isSome(createdAtOf(entry.name))));
    }).pipe(Effect.scoped),
  );

  it.effect("starts another file once the current one reaches its share of the cap", () =>
    Effect.gen(function* () {
      // An 8 MiB cap rotates at 1 MiB.
      const { logs, directory } = yield* writerIn(8 * MEBIBYTE);
      const line = "x".repeat(64 * 1024);

      for (let index = 0; index < 20; index += 1) {
        logs.append(line);
        yield* logs.flush;
      }

      const files = yield* linesIn(directory);

      assert.strictEqual(files.length, 2);
      assert.strictEqual(files.flatMap((entry) => entry.lines).length, 20);
    }).pipe(Effect.scoped),
  );

  it.effect("starts a new file in a new process, so a line a crash cut short stays alone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "movies-logs-" });
      const crashed = fileName(Date.UTC(2026, 9, 21, 11));

      yield* fs.writeFileString(path.join(directory, crashed), '{"n":1}\n{"n":2,"cut');
      yield* TestClock.setTime(Date.UTC(2026, 9, 21, 12));

      const logs = yield* RetainedLogs.make({
        directory,
        retention: { maxAgeMs: 14 * DAY, maxBytes: 512 * MEBIBYTE },
      });

      logs.append('{"n":3}');
      yield* logs.flush;

      const files = yield* linesIn(directory);

      assert.deepStrictEqual(
        files.map((entry) => entry.lines),
        [['{"n":1}', '{"n":2,"cut'], ['{"n":3}']],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("deletes expired files at startup and leaves foreign files alone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "movies-logs-" });
      const expired = fileName(Date.UTC(2026, 8, 1));
      const kept = fileName(Date.UTC(2026, 9, 20));

      for (const name of [expired, kept, "README.txt"]) {
        yield* fs.writeFileString(path.join(directory, name), "{}\n");
      }

      yield* fs.utimes(path.join(directory, expired), new Date(2026, 8, 2), new Date(2026, 8, 2));
      yield* fs.utimes(path.join(directory, kept), new Date(2026, 9, 20), new Date(2026, 9, 20));
      yield* TestClock.setTime(Date.UTC(2026, 9, 21, 12));

      yield* RetainedLogs.make({
        directory,
        retention: { maxAgeMs: 14 * DAY, maxBytes: 512 * MEBIBYTE },
      });

      assert.sameMembers(yield* fs.readDirectory(directory), [kept, "README.txt"]);
    }).pipe(Effect.scoped),
  );

  it.effect("hands a snapshot the lines written so far and later lines live, never both", () =>
    Effect.gen(function* () {
      const { logs } = yield* writerIn();

      logs.append('{"n":1}');

      const snapshot = yield* logs.snapshot;

      logs.append('{"n":2}');
      yield* logs.flush;

      assert.deepStrictEqual(
        snapshot.files.map((entry) => entry.sizeBytes),
        ['{"n":1}\n'.length],
      );
      assert.deepStrictEqual(yield* PubSub.takeAll(snapshot.live), ['{"n":2}']);
    }).pipe(Effect.scoped),
  );
});
