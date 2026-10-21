import { NodeServices } from "@effect/platform-node";
import { assert, layer } from "@effect/vitest";
import { Duration, Effect, Fiber, FileSystem, Option, Path, PlatformError, PubSub } from "effect";
import { TestClock } from "effect/testing";

import { byAge, fileCapBytes, fileName, MIN_LOG_BYTES, orderOf } from "./log-files.ts";
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

    const names = (yield* fs.readDirectory(directory)).toSorted((left, right) =>
      Option.match(Option.all([orderOf(left), orderOf(right)]), {
        onNone: () => left.localeCompare(right),
        onSome: ([leftOrder, rightOrder]) => byAge(leftOrder, rightOrder),
      }),
    );

    return yield* Effect.forEach(names, (name) =>
      fs
        .readFileString(path.join(directory, name))
        .pipe(Effect.map((text) => ({ name, lines: text.split("\n").filter(Boolean) }))),
    );
  });

/**
 * The real file system, except that the first `writeAll` to an open file writes half its bytes and
 * fails, as a full disk does.
 */
const diskFullOnce = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const state = { failed: false };

  const failingOnce = (file: FileSystem.File): FileSystem.File => ({
    [FileSystem.FileTypeId]: FileSystem.FileTypeId,
    stat: file.stat,
    seek: (offset, from) => file.seek(offset, from),
    sync: file.sync,
    read: (buffer, options) => file.read(buffer, options),
    readAlloc: (size, options) => file.readAlloc(size, options),
    truncate: (length) => file.truncate(length),
    write: (buffer) => file.write(buffer),
    writeAll: (buffer) => {
      if (state.failed) return file.writeAll(buffer);
      state.failed = true;

      return Effect.andThen(
        file.writeAll(buffer.subarray(0, Math.floor(buffer.length / 2))),
        Effect.fail(
          PlatformError.systemError({ _tag: "Unknown", module: "FileSystem", method: "writeAll" }),
        ),
      );
    },
  });

  return FileSystem.FileSystem.of({
    ...fs,
    open: (path, options) => Effect.map(fs.open(path, options), failingOnce),
  });
});

layer(NodeServices.layer)("retained log writer", (it) => {
  it.effect("ends a line a failed write cut short before writing the next", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "movies-logs-" });

      yield* TestClock.setTime(Date.UTC(2026, 9, 21, 12));

      const logs = yield* RetainedLogs.make({
        directory,
        retention: { maxAgeMs: 14 * DAY, maxBytes: MIN_LOG_BYTES },
      }).pipe(Effect.provideService(FileSystem.FileSystem, yield* diskFullOnce));

      logs.append('{"n":1,"padding":"cut here"}');
      yield* logs.flush;
      logs.append('{"n":2}');
      yield* logs.flush;

      const [only] = yield* linesIn(directory);

      assert.deepStrictEqual(only?.lines.slice(0, 2), ['{"n":1,"paddin', '{"n":2}']);
    }).pipe(Effect.scoped),
  );

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
      assert.isTrue(files.every((entry) => Option.isSome(orderOf(entry.name))));
    }).pipe(Effect.scoped),
  );

  it.effect("starts another file once the current one reaches its share of the cap", () =>
    Effect.gen(function* () {
      const { logs, directory } = yield* writerIn(8 * MEBIBYTE);
      const line = "x".repeat(64 * 1024);
      const linesPerFile = Math.floor(fileCapBytes(8 * MEBIBYTE) / (line.length + 1));
      const written = linesPerFile + 4;

      for (let index = 0; index < written; index += 1) {
        logs.append(line);
        yield* logs.flush;
      }

      const files = yield* linesIn(directory);

      assert.deepStrictEqual(
        files.map((entry) => entry.lines.length),
        [linesPerFile, written - linesPerFile],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("never lets the folder grow past its cap, and keeps several files in it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { logs, directory } = yield* writerIn(MIN_LOG_BYTES);
      const line = "x".repeat(64 * 1024);
      const folderBytes = Array.of<number>();

      for (let index = 0; index < 400; index += 1) {
        logs.append(line);
        yield* logs.flush;

        const sizes = yield* Effect.forEach(yield* fs.readDirectory(directory), (name) =>
          Effect.map(fs.stat(path.join(directory, name)), (info) => Number(info.size)),
        );

        folderBytes.push(sizes.reduce((total, size) => total + size, 0));
      }

      assert.isAtMost(Math.max(...folderBytes), MIN_LOG_BYTES);
      assert.isAtLeast((yield* fs.readDirectory(directory)).length, 7);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps its folder and files private to the service", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "movies-logs-" });
      const directory = path.join(parent, "logs");
      const earlier = path.join(directory, fileName(Date.UTC(2026, 9, 20)));

      yield* fs.makeDirectory(directory, { mode: 0o755 });
      yield* fs.writeFileString(earlier, "{}\n", { mode: 0o644 });
      yield* TestClock.setTime(Date.UTC(2026, 9, 21, 12));

      const logs = yield* RetainedLogs.make({
        directory,
        retention: { maxAgeMs: 14 * DAY, maxBytes: MIN_LOG_BYTES },
      });

      logs.append('{"n":1}');
      yield* logs.flush;

      const modes = yield* Effect.forEach(
        [
          directory,
          ...(yield* fs.readDirectory(directory)).map((name) => path.join(directory, name)),
        ],
        (entry) => Effect.map(fs.stat(entry), (info) => info.mode & 0o777),
      );

      assert.deepStrictEqual(modes, [0o700, 0o600, 0o600]);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps running without its folder, and writes again once it can", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "movies-logs-" });
      const directory = path.join(parent, "logs");

      // A file where the folder should be: the folder cannot be made.
      yield* fs.writeFileString(directory, "");
      yield* TestClock.setTime(Date.UTC(2026, 9, 21, 12));

      const logs = yield* RetainedLogs.make({
        directory,
        retention: { maxAgeMs: 14 * DAY, maxBytes: MIN_LOG_BYTES },
      });

      logs.append('{"n":1}');
      yield* logs.flush;
      yield* fs.remove(directory);
      logs.append('{"n":2}');
      yield* logs.flush;

      const recovered = (yield* linesIn(directory)).flatMap((entry) => entry.lines);

      assert.strictEqual(recovered[0], '{"n":2}');
      assert.match(recovered[1] ?? "", /"RetainedLogs\.dropped".*"lines":1/u);

      // Deleted while it runs: made again with the next batch.
      yield* fs.remove(directory, { recursive: true });
      logs.append('{"n":3}');
      yield* logs.flush;

      assert.deepStrictEqual(
        (yield* linesIn(directory)).map((entry) => entry.lines),
        [['{"n":3}']],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("names each file after a time none of its records is earlier than", () =>
    Effect.gen(function* () {
      const { logs, directory } = yield* writerIn();
      const loggedAt = Date.UTC(2026, 9, 21, 12) + 100;

      yield* TestClock.adjust(Duration.millis(100));
      logs.append(`{"timestamp":"${new Date(loggedAt).toISOString()}"}`);
      yield* TestClock.adjust(Duration.millis(400));
      yield* logs.flush;

      const [only] = yield* linesIn(directory);

      assert.isAtMost(
        Option.getOrThrow(orderOf(only?.name ?? "")).startsAt,
        loggedAt,
        "the file's name is no later than its first record",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("ends every follow when it begins to close", () =>
    Effect.gen(function* () {
      const { logs } = yield* writerIn();
      const closing = yield* Effect.forkChild(logs.closing);

      yield* logs.close;

      assert.isTrue(Option.isSome(yield* Fiber.await(closing).pipe(Effect.option)));
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
