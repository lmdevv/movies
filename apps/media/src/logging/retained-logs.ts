/**
 * The retained log writer. The console logger hands it every line it prints, already redacted,
 * with the time it was logged; a background fiber appends them to the current file a few times a
 * second and publishes them to readers that follow the log. A new process always starts a new
 * file, so a line cut short by a crash is never continued; readers skip it, and a write that
 * failed partway is followed by a line break for the same reason. Rotation and retention
 * (`log-files.ts`) run under the same lock as writes, so a reader's snapshot never sees a file half
 * deleted or half written, and the oldest files go before a write would take the folder past its
 * size cap. Each new file takes the next sequence number, so files keep the order they were
 * written in whatever the clock does, and starts at its first record's time, so no record in it is
 * earlier than its name says.
 *
 * The folder is private to the service (0700, files 0600). When it cannot be created, written, or
 * listed, the service keeps running with its standard output only, says so once, and tries the
 * folder again with every batch, creating it again if it was deleted. It lists the folder again
 * once it can, so files that appear later, as on a late mount, count against the cap at once.
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
  Ref,
  Result,
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
  nextSequence,
  orderOf,
  planMigration,
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
  /**
   * Since when the folder could not be written or listed; none while it works. Records logged
   * since then went to standard output only.
   */
  readonly unavailableSince: Option.Option<number>;
}

/** The retained log. */
export interface Interface {
  /**
   * Queues one line, logged at `loggedAt`; it is written within a moment. Never blocks, so a
   * logger may call it.
   */
  readonly append: (line: string, loggedAt: number) => void;
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

/**
 * Characters of lines waiting for the writer; beyond this, new lines are dropped and counted. The
 * writer takes the queue four times a second, so this is far more than the service logs, and it
 * bounds the memory a flood of log lines can hold.
 */
const MAX_PENDING_CHARS = 8 * 1024 * 1024;

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

/** One line waiting for the writer, and when it was logged. */
interface Entry {
  readonly line: string;
  readonly loggedAt: number;
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

/** Lines ready to write, as UTF-8 groups of `lines` lines each, none logged before `firstAt`. */
interface Chunk {
  readonly bytes: Uint8Array;
  readonly lines: number;
  readonly firstAt: number;
}

/** Lines ready to write in groups, all of them in order, and how many no file could hold. */
interface Chunks {
  readonly chunks: ReadonlyArray<Chunk>;
  readonly lines: ReadonlyArray<string>;
  readonly oversized: number;
}

/** `entries` as UTF-8, each with its line break, grouped so no group is larger than `capBytes`. */
const chunksOf = (entries: ReadonlyArray<Entry>, capBytes: number): Chunks => {
  const chunks: Array<Chunk> = [];
  const lines: Array<string> = [];
  let group: Array<string> = [];
  let groupBytes = 0;
  let firstAt = Number.POSITIVE_INFINITY;
  let oversized = 0;

  const close = (): void => {
    if (group.length > 0) {
      chunks.push({ bytes: encoder.encode(`${group.join("\n")}\n`), lines: group.length, firstAt });
    }

    group = [];
    groupBytes = 0;
    firstAt = Number.POSITIVE_INFINITY;
  };

  for (const entry of entries) {
    const bytes = encoder.encode(entry.line).length + 1;

    if (bytes > capBytes) {
      oversized += 1;
      continue;
    }

    if (groupBytes + bytes > capBytes) close();
    group.push(entry.line);
    lines.push(entry.line);
    groupBytes += bytes;
    firstAt = Math.min(firstAt, entry.loggedAt);
  }

  close();

  return { chunks, lines, oversized };
};

/** Builds the writer for `settings`; it lives, and flushes a last time, until the scope closes. */
export const make = Effect.fn("RetainedLogs.make")(function* (settings: Settings) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const lock = yield* Semaphore.make(1);
  const published = yield* PubSub.sliding<string>(LIVE_CAPACITY);
  const closing = yield* Deferred.make<void>();
  const current = yield* Ref.make(Option.none<OpenFile>());
  const lastPrune = yield* Ref.make(0);
  /** All log files together, as of the last listing plus what was written since. */
  const totalBytes = yield* Ref.make(0);
  /** The sequence number the next file takes. */
  const sequence = yield* Ref.make(0);
  const capBytes = fileCapBytes(settings.retention.maxBytes);

  /** Lines logged since the writer last took them, and their length in characters. */
  const queue = { entries: Array.of<Entry>(), chars: 0 };

  /**
   * Lines dropped since the last write; since when writing has failed, so the failure is said
   * once and readers hear of it; whether the last write may have stopped partway through a line;
   * and whether the folder must be listed again before its total or the next sequence number is
   * trusted. Only `append` and the writer touch them.
   */
  const counters = {
    dropped: 0,
    failingSince: Option.none<number>(),
    partial: false,
    stale: true,
  };

  // The mode is tightened where it can be; a folder the service may write but not chmod, such
  // as one another user owns, is still written.
  const ensureDirectory = fs
    .makeDirectory(settings.directory, { recursive: true, mode: DIRECTORY_MODE })
    .pipe(Effect.andThen(fs.chmod(settings.directory, DIRECTORY_MODE).pipe(Effect.ignore)));

  /** The log files, oldest first; fails when the folder cannot be read. */
  const listFiles = Effect.gen(function* () {
    const names = yield* fs.readDirectory(settings.directory);

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

  /**
   * Lists the folder and deletes what retention says, making room for `reserveBytes` more. A
   * folder that cannot be listed is left alone and listed again with the next batch.
   */
  const prune = Effect.fnUntraced(function* (reserveBytes: number) {
    const now = yield* Clock.currentTimeMillis;
    const listed = yield* Effect.result(listFiles);

    if (Result.isFailure(listed)) {
      counters.stale = true;

      return;
    }

    const files = listed.success;
    const active = Option.map(yield* Ref.get(current), (file) => file.name);
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
    yield* Ref.update(sequence, (next) => Math.max(next, nextSequence(files)));
    yield* Ref.set(
      totalBytes,
      files.reduce((total, file) => (doomed.has(file.name) ? total : total + file.sizeBytes), 0),
    );
    yield* Ref.set(lastPrune, now);
    counters.stale = false;
  });

  const closeCurrent = Effect.gen(function* () {
    const previous = yield* Ref.getAndSet(current, Option.none());

    if (Option.isSome(previous)) yield* Scope.close(previous.value.scope, Exit.void);
  });

  /** Starts the next file, for records from `startsAt` on. */
  const rotate = Effect.fnUntraced(function* (startsAt: number) {
    yield* closeCurrent;
    yield* ensureDirectory;

    // The next sequence number comes from a listing of the folder as it is now.
    if (counters.stale) yield* prune(0);

    const fileScope = yield* Scope.make("sequential");
    const name = fileName(yield* Ref.getAndUpdate(sequence, (next) => next + 1), startsAt);

    const handle = yield* fs
      .open(path.join(settings.directory, name), { flag: "a", mode: FILE_MODE })
      .pipe(Scope.provide(fileScope));

    const opened: OpenFile = { name, startsAt, sizeBytes: 0, handle, scope: fileScope };

    yield* Ref.set(current, Option.some(opened));
    counters.partial = false;

    return opened;
  });

  /**
   * The file `chunk`, `bytes` long, goes to: the current one, unless it is full, from an earlier
   * day, begun after the chunk's first record, or gone.
   */
  const fileFor = Effect.fnUntraced(function* (chunk: Chunk, bytes: number) {
    const open = yield* Ref.get(current);

    if (Option.isSome(open) && !shouldRotate(open.value, chunk.firstAt, capBytes, bytes)) {
      if (yield* fs.exists(path.join(settings.directory, open.value.name))) return open.value;
      // Deleted, or another folder mounted over this one: what the folder holds is unknown.
      counters.stale = true;
    }

    return yield* rotate(chunk.firstAt);
  });

  /**
   * Appends `chunk`; after a write that stopped partway, a line break first ends the fragment, and
   * the file's size is read again, since the fragment's length is unknown.
   */
  const writeChunk = Effect.fnUntraced(function* (chunk: Chunk) {
    const file = yield* fileFor(chunk, chunk.bytes.length + (counters.partial ? 1 : 0));
    const bytes = counters.partial ? afterLineBreak(chunk.bytes) : chunk.bytes;

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
    Option.isSome(counters.failingSince)
      ? Effect.void
      : Effect.andThen(
          Effect.sync(() => {
            counters.failingSince = Option.some(now);
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

  /** Writes `queued`, taken at `now`. */
  const write = Effect.fnUntraced(function* (now: number, queued: ReadonlyArray<Entry>) {
    const dropped = counters.dropped;

    counters.dropped = 0;

    const entries: ReadonlyArray<Entry> =
      dropped > 0
        ? [
            ...queued,
            {
              line: ownLine("WARN", "RetainedLogs.dropped", { lines: dropped }, now),
              loggedAt: now,
            },
          ]
        : queued;

    const { chunks, lines, oversized } = chunksOf(entries, capBytes);

    counters.dropped += oversized;

    let written = 0;

    yield* Effect.forEach(
      chunks,
      (chunk) =>
        Effect.andThen(
          writeChunk(chunk),
          Effect.sync(() => {
            written += 1;
          }),
        ),
      { discard: true },
    ).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          counters.failingSince = Option.none();
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
            counters.stale = true;
          }),
          failed(now, error),
        ),
      ),
    );
    // A follow shows what the service logs even while the folder is failing, but never a line
    // no file could hold, which no later read would find.
    yield* PubSub.publishAll(published, lines);
  });

  const flushLocked = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const queued = queue.entries;

    queue.entries = [];
    queue.chars = 0;

    if (queued.length > 0 || counters.dropped > 0) yield* write(now, queued);

    // Either way, so a clock stepped back an hour still prunes on time.
    if (counters.stale || Math.abs(now - (yield* Ref.get(lastPrune))) >= PRUNE_INTERVAL_MS) {
      yield* prune(0);
    }
  });

  const flush = lock.withPermits(1)(flushLocked);

  const close = Deferred.succeed(closing, undefined).pipe(Effect.asVoid);

  /** Gives files under the earlier naming their place after the current ones. */
  const migrate = fs.readDirectory(settings.directory).pipe(
    Effect.flatMap((names) =>
      Effect.forEach(
        planMigration(names),
        ([from, to]) =>
          fs
            .rename(path.join(settings.directory, from), path.join(settings.directory, to))
            .pipe(Effect.ignore),
        { discard: true },
      ),
    ),
    Effect.ignore,
  );

  const startedAt = yield* Clock.currentTimeMillis;

  yield* ensureDirectory.pipe(Effect.catch((error) => failed(startedAt, error)));
  yield* migrate;
  yield* Effect.forEach(
    yield* listFiles.pipe(Effect.orElseSucceed(() => [])),
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
    append: (line, loggedAt) => {
      if (queue.chars + line.length > MAX_PENDING_CHARS) {
        counters.dropped += 1;

        return;
      }

      queue.entries.push({ line, loggedAt });
      queue.chars += line.length;
    },
    flush,
    snapshot: lock.withPermits(1)(
      Effect.gen(function* () {
        yield* flushLocked;
        const now = yield* Clock.currentTimeMillis;
        const listed = yield* Effect.result(listFiles);
        const live = yield* PubSub.subscribe(published);

        return {
          directory: settings.directory,
          files: Result.getOrElse(listed, () => []),
          live,
          unavailableSince: Option.orElse(counters.failingSince, () =>
            Result.isFailure(listed) ? Option.some(now) : Option.none(),
          ),
        } satisfies Snapshot;
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
