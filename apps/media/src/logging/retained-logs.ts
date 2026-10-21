/**
 * The retained log writer. The console logger hands it every line it prints, already redacted;
 * a background fiber appends them to the current file a few times a second and publishes them to
 * readers that follow the log. A new process always starts a new file, so a line cut short by a
 * crash is never continued; readers skip it, and a write that failed partway is followed by a line
 * break for the same reason. Rotation and retention (`log-files.ts`) run under the same lock as
 * writes, so a reader's snapshot never sees a file half deleted or half written, and the oldest
 * files go before a write would take the folder past its size cap.
 *
 * The folder is private to the service (0700, files 0600). When it cannot be created or written,
 * the service keeps running with its standard output only, says so once, and tries the folder
 * again with every batch, creating it again if it was deleted.
 */
import {
  Clock,
  Console,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  PubSub,
  Queue,
  Ref,
  Schedule,
  Scope,
  Semaphore,
} from "effect";

import * as MediaConfig from "../media-config.ts";
import { isNotFound, modifiedAtMs } from "../platform/file-info.ts";
import {
  byAge,
  fileCapBytes,
  fileName,
  type LogFile,
  orderOf,
  planPrune,
  type Retention,
  shouldRotate,
} from "./log-files.ts";

/** The log files at one moment, and every line written after it. */
interface Snapshot {
  readonly directory: string;
  /** Oldest first, each with its size at that moment: read no further than `sizeBytes`. */
  readonly files: ReadonlyArray<LogFile>;
  /** Lines written after the snapshot, until the scope closes. A reader that lags loses the oldest. */
  readonly live: PubSub.Subscription<string>;
}

/** The retained log. */
export interface Interface {
  /** Queues one line; it is written within a moment. Never blocks, so a logger may call it. */
  readonly append: (line: string) => void;
  /** Writes every queued line now. */
  readonly flush: Effect.Effect<void>;
  /** The files as they stand now and the lines written from now on, for the rest of the scope. */
  readonly snapshot: Effect.Effect<Snapshot, never, Scope.Scope>;
  /**
   * Completes once the service begins to shut down. A reader that follows the log ends then, so
   * an open follow never holds up the shutdown.
   */
  readonly closing: Effect.Effect<void>;
  /** Begins the shutdown for readers: every follow ends now. */
  readonly close: Effect.Effect<void>;
}

/** The retained log service. */
export class Service extends Context.Service<Service, Interface>()("@movies/media/RetainedLogs") {}

/** Where and how much to keep. */
export interface Settings {
  readonly directory: string;
  readonly retention: Retention;
}

/** Lines waiting for the writer; beyond this, new lines are dropped and counted. */
const MAX_PENDING = 10_000;

/** Lines a following reader may lag behind before it loses the oldest. */
const LIVE_CAPACITY = 4096;

const FLUSH_INTERVAL = Duration.millis(250);

const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

const DIRECTORY_MODE = 0o700;

const FILE_MODE = 0o600;

interface OpenFile {
  readonly name: string;
  readonly startsAt: number;
  readonly sizeBytes: number;
  readonly handle: FileSystem.File;
  readonly scope: Scope.Closeable;
}

const encoder = new TextEncoder();

/** A record of the writer's own, in the logger's JSON shape. */
const ownLine = (
  level: "WARN" | "ERROR",
  message: string,
  annotations: Readonly<Record<string, string | number>>,
  now: number,
): string =>
  JSON.stringify({
    message,
    level,
    timestamp: new Date(now).toISOString(),
    annotations,
    spans: {},
  });

/** `chunk` after a line break. */
const afterLineBreak = (chunk: Uint8Array): Uint8Array => {
  const bytes = new Uint8Array(chunk.length + 1);

  bytes[0] = 0x0a;
  bytes.set(chunk, 1);

  return bytes;
};

/** Lines ready to write, as UTF-8 groups of `lines` lines each. */
interface Chunk {
  readonly bytes: Uint8Array;
  readonly lines: number;
}

/** Lines ready to write in groups, and how many lines were too large for any file. */
interface Chunks {
  readonly chunks: ReadonlyArray<Chunk>;
  readonly oversized: number;
}

/** `lines` as UTF-8, each with its line break, grouped so no group is larger than `capBytes`. */
const chunksOf = (lines: ReadonlyArray<string>, capBytes: number): Chunks => {
  const chunks: Array<Chunk> = [];
  let group: Array<string> = [];
  let groupBytes = 0;
  let oversized = 0;

  const close = (): void => {
    if (group.length > 0) {
      chunks.push({ bytes: encoder.encode(`${group.join("\n")}\n`), lines: group.length });
    }

    group = [];
    groupBytes = 0;
  };

  for (const line of lines) {
    const bytes = encoder.encode(line).length + 1;

    if (bytes > capBytes) {
      oversized += 1;
      continue;
    }

    if (groupBytes + bytes > capBytes) close();
    group.push(line);
    groupBytes += bytes;
  }

  close();

  return { chunks, oversized };
};

/** Builds the writer for `settings`; it lives, and flushes a last time, until the scope closes. */
export const make = Effect.fn("RetainedLogs.make")(function* (settings: Settings) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const lock = yield* Semaphore.make(1);
  const pending = yield* Queue.dropping<string>(MAX_PENDING);
  const published = yield* PubSub.sliding<string>(LIVE_CAPACITY);
  const closing = yield* Deferred.make<void>();
  const current = yield* Ref.make(Option.none<OpenFile>());
  const lastPrune = yield* Ref.make(0);
  /** All log files together, as of the last listing plus what was written since. */
  const totalBytes = yield* Ref.make(0);
  const capBytes = fileCapBytes(settings.retention.maxBytes);

  /**
   * Lines dropped since the last write; whether writing is failing, so the failure is said once;
   * and whether the last write may have stopped partway through a line. Only `append` and the
   * writer touch them.
   */
  const counters = { dropped: 0, failing: false, partial: false };

  // The mode is tightened where it can be; a folder the service may write but not chmod, such
  // as one another user owns, is still written.
  const ensureDirectory = fs
    .makeDirectory(settings.directory, { recursive: true, mode: DIRECTORY_MODE })
    .pipe(Effect.andThen(fs.chmod(settings.directory, DIRECTORY_MODE).pipe(Effect.ignore)));

  const listFiles = Effect.gen(function* () {
    const names = yield* fs.readDirectory(settings.directory).pipe(Effect.orElseSucceed(() => []));

    const files = yield* Effect.forEach(names, (name) =>
      Option.match(orderOf(name), {
        onNone: () => Effect.succeed(Option.none<LogFile>()),
        onSome: (order) =>
          fs.stat(path.join(settings.directory, name)).pipe(
            Effect.map((info) =>
              Option.some<LogFile>({
                name,
                ...order,
                sizeBytes: Number(info.size),
                modifiedAt: modifiedAtMs(info),
              }),
            ),
            Effect.orElseSucceed(() => Option.none<LogFile>()),
          ),
      }),
    );

    return files.flatMap((file) => (Option.isSome(file) ? [file.value] : [])).toSorted(byAge);
  });

  /** Deletes what retention says, making room for `reserveBytes` more. */
  const prune = Effect.fnUntraced(function* (reserveBytes: number) {
    const now = yield* Clock.currentTimeMillis;
    const active = Option.map(yield* Ref.get(current), (file) => file.name);
    const files = yield* listFiles;
    const doomed = new Set(planPrune(files, settings.retention, now, active, reserveBytes));

    yield* Effect.forEach(
      doomed,
      (name) =>
        fs.remove(path.join(settings.directory, name)).pipe(
          Effect.catchIf(isNotFound, () => Effect.void),
          Effect.catch((error) =>
            Console.error(`Retained log ${name} could not be deleted: ${error.message}`),
          ),
        ),
      { discard: true },
    );
    yield* Ref.set(
      totalBytes,
      files.reduce((total, file) => (doomed.has(file.name) ? total : total + file.sizeBytes), 0),
    );
    yield* Ref.set(lastPrune, now);
  });

  const closeCurrent = Effect.gen(function* () {
    const previous = yield* Ref.getAndSet(current, Option.none());

    if (Option.isSome(previous)) yield* Scope.close(previous.value.scope, Exit.void);
  });

  /** Starts a file for records from `startsAt` on. */
  const rotate = Effect.fnUntraced(function* (startsAt: number) {
    yield* closeCurrent;
    yield* ensureDirectory;

    let sequence = 0;

    while (yield* fs.exists(path.join(settings.directory, fileName(startsAt, sequence)))) {
      sequence += 1;
    }

    const fileScope = yield* Scope.make("sequential");
    const name = fileName(startsAt, sequence);

    const handle = yield* fs
      .open(path.join(settings.directory, name), { flag: "a", mode: FILE_MODE })
      .pipe(Scope.provide(fileScope));

    const opened: OpenFile = { name, startsAt, sizeBytes: 0, handle, scope: fileScope };

    yield* Ref.set(current, Option.some(opened));
    counters.partial = false;

    return opened;
  });

  /**
   * The file the next `bytes`, none of them earlier than `floor`, go to: the current one, unless
   * it is full, from an earlier day, or gone.
   */
  const fileFor = Effect.fnUntraced(function* (now: number, floor: number, bytes: number) {
    const open = yield* Ref.get(current);

    if (
      Option.isSome(open) &&
      !shouldRotate(open.value, now, capBytes, bytes) &&
      (yield* fs.exists(path.join(settings.directory, open.value.name)))
    ) {
      return open.value;
    }

    return yield* rotate(floor);
  });

  /**
   * Appends `chunk`; after a write that stopped partway, a line break first ends the fragment, and
   * the file's size is read again, since the fragment's length is unknown.
   */
  const writeChunk = Effect.fnUntraced(function* (now: number, floor: number, chunk: Uint8Array) {
    const file = yield* fileFor(now, floor, chunk.length + (counters.partial ? 1 : 0));
    const bytes = counters.partial ? afterLineBreak(chunk) : chunk;

    if ((yield* Ref.get(totalBytes)) + bytes.length > settings.retention.maxBytes) {
      yield* prune(bytes.length);
    }

    counters.partial = true;
    yield* file.handle.writeAll(bytes).pipe(
      Effect.tapError(() =>
        file.handle.stat.pipe(
          Effect.flatMap((info) =>
            Ref.set(current, Option.some({ ...file, sizeBytes: Number(info.size) })),
          ),
          Effect.andThen(Ref.set(lastPrune, 0)),
          Effect.ignore,
        ),
      ),
    );
    counters.partial = false;
    yield* Ref.set(current, Option.some({ ...file, sizeBytes: file.sizeBytes + bytes.length }));
    yield* Ref.update(totalBytes, (total) => total + bytes.length);
  });

  /** Tells standard output, once per failure, that the files are not being written. */
  const failed = (now: number, error: { readonly message: string }) =>
    counters.failing
      ? Effect.void
      : Effect.andThen(
          Effect.sync(() => {
            counters.failing = true;
          }),
          Console.log(
            ownLine(
              "WARN",
              "RetainedLogs.unwritable",
              { directory: settings.directory, error: error.message },
              now,
            ),
          ),
        );

  /**
   * Writes `queued`, taken at `now`. Every line of it was logged at `floor` or later, so a file
   * it starts is named after `floor`.
   */
  const write = Effect.fnUntraced(function* (
    now: number,
    floor: number,
    queued: ReadonlyArray<string>,
  ) {
    const dropped = counters.dropped;

    counters.dropped = 0;

    const lines =
      dropped > 0
        ? [...queued, ownLine("WARN", "RetainedLogs.dropped", { lines: dropped }, now)]
        : queued;

    const { chunks, oversized } = chunksOf(lines, capBytes);

    counters.dropped += oversized;

    let written = 0;

    yield* Effect.forEach(
      chunks,
      (chunk) =>
        Effect.andThen(
          writeChunk(now, floor, chunk.bytes),
          Effect.sync(() => {
            written += 1;
          }),
        ),
      { discard: true },
    ).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          counters.failing = false;
        }),
      ),
      Effect.catch((error) =>
        Effect.andThen(
          Effect.sync(() => {
            // The failed chunk and those after it; the last holds this batch's drop count.
            counters.dropped +=
              dropped +
              chunks.slice(written).reduce((total, chunk) => total + chunk.lines, 0) -
              (dropped > 0 ? 1 : 0);
          }),
          failed(now, error),
        ),
      ),
    );
    yield* PubSub.publishAll(published, lines);
  });

  /**
   * The time read just before the queue was last emptied. Every line queued since was logged
   * after it, so it names the files those lines start: no record is ever older than the name of
   * its file.
   */
  const floor = yield* Ref.make(yield* Clock.currentTimeMillis);

  const flushLocked = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const since = yield* Ref.getAndSet(floor, now);
    const queued = yield* Queue.clear(pending);

    if (queued.length > 0 || counters.dropped > 0) yield* write(now, since, queued);

    if (now - (yield* Ref.get(lastPrune)) >= PRUNE_INTERVAL_MS) yield* prune(0);
  });

  const flush = lock.withPermits(1)(flushLocked);

  const close = Deferred.succeed(closing, undefined).pipe(Effect.asVoid);

  const startedAt = yield* Clock.currentTimeMillis;

  yield* ensureDirectory.pipe(Effect.catch((error) => failed(startedAt, error)));
  yield* Effect.forEach(
    yield* listFiles,
    (file) => fs.chmod(path.join(settings.directory, file.name), FILE_MODE).pipe(Effect.ignore),
    { discard: true },
  );
  yield* prune(0);

  // Registered before the flushing fiber starts, so it runs after that fiber stopped: nothing can
  // open a file after the last flush closed it.
  yield* Effect.addFinalizer(() =>
    lock.withPermits(1)(Effect.andThen(flushLocked, closeCurrent)).pipe(Effect.andThen(close)),
  );
  yield* Effect.forkScoped(
    Effect.repeat(Effect.uninterruptible(flush), Schedule.spaced(FLUSH_INTERVAL)),
  );

  return Service.of({
    append: (line) => {
      if (!Queue.offerUnsafe(pending, line)) counters.dropped += 1;
    },
    flush,
    snapshot: lock.withPermits(1)(
      Effect.gen(function* () {
        yield* flushLocked;
        const files = yield* listFiles;
        const live = yield* PubSub.subscribe(published);

        return { directory: settings.directory, files, live } satisfies Snapshot;
      }),
    ),
    closing: Deferred.await(closing),
    close,
  });
});

/** The writer for the configured `DATA_DIR/logs`. */
export const layer: Layer.Layer<
  Service,
  never,
  MediaConfig.Service | FileSystem.FileSystem | Path.Path
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* MediaConfig.Service;

    return yield* make({
      directory: config.logs.directory,
      retention: {
        maxAgeMs: Duration.toMillis(config.logs.retention),
        maxBytes: config.logs.maxBytes,
      },
    });
  }),
);
