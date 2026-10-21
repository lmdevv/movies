/**
 * The retained log writer. The console logger hands it every line it prints, already redacted;
 * a background fiber appends them to the current file a few times a second and publishes them to
 * readers that follow the log. A new process always starts a new file, so a line cut short by a
 * crash is never continued; readers skip it. Rotation and retention (`log-files.ts`) run under the
 * same lock as writes, so a reader's snapshot never sees a file half deleted or half written.
 */
import {
  Clock,
  Console,
  Context,
  Effect,
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
  Exit,
  Duration,
} from "effect";

import * as MediaConfig from "../media-config.ts";
import { isNotFound, modifiedAtMs } from "../platform/file-info.ts";
import {
  createdAtOf,
  fileCapBytes,
  fileName,
  type LogFile,
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

interface OpenFile {
  readonly name: string;
  readonly createdAt: number;
  readonly sizeBytes: number;
  readonly handle: FileSystem.File;
  readonly scope: Scope.Closeable;
}

const encoder = new TextEncoder();

/** A record in the log's own format saying how many lines were dropped. */
const droppedLine = (count: number, now: number): string =>
  JSON.stringify({
    message: "RetainedLogs.dropped",
    level: "WARN",
    timestamp: new Date(now).toISOString(),
    annotations: { lines: count },
    spans: {},
  });

/** Builds the writer for `settings`; it lives, and flushes a last time, until the scope closes. */
export const make = Effect.fn("RetainedLogs.make")(function* (settings: Settings) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const lock = yield* Semaphore.make(1);
  const pending = yield* Queue.dropping<string>(MAX_PENDING);
  const published = yield* PubSub.sliding<string>(LIVE_CAPACITY);
  const current = yield* Ref.make(Option.none<OpenFile>());
  const lastPrune = yield* Ref.make(0);
  const capBytes = fileCapBytes(settings.retention.maxBytes);
  /** Lines dropped since the last write, and whether writing is failing; only `append` and the writer touch them. */
  const counters = { dropped: 0, failing: false };

  yield* fs.makeDirectory(settings.directory, { recursive: true }).pipe(Effect.orDie);

  const listFiles = Effect.gen(function* () {
    const names = yield* fs.readDirectory(settings.directory).pipe(Effect.orElseSucceed(() => []));

    const files = yield* Effect.forEach(names, (name) =>
      Option.match(createdAtOf(name), {
        onNone: () => Effect.succeed(Option.none<LogFile>()),
        onSome: (createdAt) =>
          fs.stat(path.join(settings.directory, name)).pipe(
            Effect.map((info) =>
              Option.some<LogFile>({
                name,
                createdAt,
                sizeBytes: Number(info.size),
                modifiedAt: modifiedAtMs(info),
              }),
            ),
            Effect.orElseSucceed(() => Option.none<LogFile>()),
          ),
      }),
    );

    return files
      .flatMap((file) => (Option.isSome(file) ? [file.value] : []))
      .toSorted((left, right) => left.createdAt - right.createdAt);
  });

  const prune = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const active = Option.map(yield* Ref.get(current), (file) => file.name);
    const doomed = planPrune(yield* listFiles, settings.retention, now, active);

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
    yield* Ref.set(lastPrune, now);
  });

  /** Closes the current file and opens one named for `now`, then applies retention. */
  const rotate = Effect.fnUntraced(function* (now: number) {
    const previous = yield* Ref.getAndSet(current, Option.none());

    if (Option.isSome(previous)) yield* Scope.close(previous.value.scope, Exit.void);

    let createdAt = now;

    while (yield* fs.exists(path.join(settings.directory, fileName(createdAt)))) createdAt += 1;

    // Closed by rotation or, after the last flush, by the finalizer below; never before that flush.
    const fileScope = yield* Scope.make("sequential");
    const name = fileName(createdAt);

    const handle = yield* fs
      .open(path.join(settings.directory, name), { flag: "a" })
      .pipe(Scope.provide(fileScope));

    const opened: OpenFile = { name, createdAt, sizeBytes: 0, handle, scope: fileScope };

    yield* Ref.set(current, Option.some(opened));
    yield* prune;

    return opened;
  });

  const write = Effect.fnUntraced(function* (lines: ReadonlyArray<string>) {
    const now = yield* Clock.currentTimeMillis;
    const open = yield* Ref.get(current);

    const file =
      Option.isSome(open) && !shouldRotate(open.value, now, capBytes)
        ? open.value
        : yield* rotate(now);

    const bytes = encoder.encode(`${lines.join("\n")}\n`);

    yield* file.handle.writeAll(bytes);
    yield* Ref.set(current, Option.some({ ...file, sizeBytes: file.sizeBytes + bytes.length }));
  });

  /** Writes and publishes the queued lines. Call with the lock held. */
  const flushLocked = Effect.gen(function* () {
    const queued = yield* Queue.clear(pending);
    const now = yield* Clock.currentTimeMillis;
    const dropped = counters.dropped;

    counters.dropped = 0;
    const lines = dropped > 0 ? [...queued, droppedLine(dropped, now)] : queued;

    if (lines.length > 0) {
      yield* write(lines).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            counters.failing = false;
          }),
        ),
        Effect.catch((error) =>
          counters.failing
            ? Effect.void
            : Effect.andThen(
                Effect.sync(() => {
                  counters.failing = true;
                }),
                Console.error(`Retained logs could not be written: ${error.message}`),
              ),
        ),
      );
      yield* PubSub.publishAll(published, lines);
    }

    if (now - (yield* Ref.get(lastPrune)) >= PRUNE_INTERVAL_MS) yield* prune;
  });

  const flush = lock.withPermits(1)(flushLocked);

  yield* prune;
  yield* Effect.forkScoped(Effect.repeat(flush, Schedule.spaced(FLUSH_INTERVAL)));
  yield* Effect.addFinalizer(() =>
    lock.withPermits(1)(
      flushLocked.pipe(
        Effect.andThen(Ref.getAndSet(current, Option.none())),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (file) => Scope.close(file.scope, Exit.void),
          }),
        ),
      ),
    ),
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
