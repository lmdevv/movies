/**
 * Keeps the caches under `DATA_DIR` (provider responses, keyframe indexes, converted subtitles,
 * and downloaded or resized artwork) within `CACHE_MAX_MB`. Every pass removes temporary files a
 * crashed write left behind, then the least recently used files until the total fits. Cache reads
 * touch the files they hit, so modification time stands for last use. Everything here can be
 * rebuilt: a pruned entry is fetched, scanned, or resized again on its next request.
 */
import { Clock, Duration, Effect, FileSystem, Layer, Option, Path, Schedule } from "effect";

import * as MediaConfig from "./media-config.ts";

/** What one pass removed. */
interface PruneSummary {
  readonly removedFiles: number;
  readonly removedBytes: number;
  readonly keptBytes: number;
}

/** A file under a cache folder. */
interface CacheFile {
  readonly path: string;
  readonly size: number;
  readonly modifiedAt: number;
}

const PRUNE_EVERY = Duration.hours(1);

/** A `.part` file older than this belongs to a write that will never finish. */
const ABANDONED_AFTER = Duration.hours(1);

/** The cache folders under `dataDir`. */
export const cacheDirectories = (dataDir: string, path: Path.Path): ReadonlyArray<string> => [
  path.join(dataDir, "cache"),
  path.join(dataDir, "artwork"),
];

/** Every file under `roots`, with its size and modification time. Missing folders are empty. */
const listFiles = Effect.fnUntraced(function* (roots: ReadonlyArray<string>) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const perRoot = yield* Effect.forEach(roots, (root) =>
    fs.readDirectory(root, { recursive: true }).pipe(
      Effect.orElseSucceed(() => []),
      Effect.flatMap((names) =>
        Effect.forEach(names, (name) =>
          fs.stat(path.join(root, name)).pipe(
            Effect.map((info) =>
              info.type === "File"
                ? Option.some<CacheFile>({
                    path: path.join(root, name),
                    size: Number(info.size),
                    modifiedAt: Option.match(info.mtime, {
                      onNone: () => 0,
                      onSome: (date) => date.getTime(),
                    }),
                  })
                : Option.none(),
            ),
            Effect.orElseSucceed(() => Option.none<CacheFile>()),
          ),
        ),
      ),
    ),
  );

  return perRoot.flat().flatMap((file) => (Option.isSome(file) ? [file.value] : []));
});

/**
 * Removes abandoned temporary files under `roots`, then the oldest files until the rest take at
 * most `maxBytes`.
 */
export const prune = Effect.fn("CachePruner.prune")(function* (
  roots: ReadonlyArray<string>,
  maxBytes: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const now = yield* Clock.currentTimeMillis;
  const files = yield* listFiles(roots);
  const abandonedBefore = now - Duration.toMillis(ABANDONED_AFTER);

  const abandoned = files.filter(
    (file) => path.basename(file.path).includes(".part") && file.modifiedAt < abandonedBefore,
  );

  const live = files
    .filter((file) => !abandoned.includes(file))
    .toSorted((left, right) => right.modifiedAt - left.modifiedAt);

  // Keep the newest files that fit; everything older goes.
  let keptBytes = 0;
  const expired: Array<CacheFile> = [];

  for (const file of live) {
    if (keptBytes + file.size <= maxBytes) keptBytes += file.size;
    else expired.push(file);
  }

  const removed = yield* Effect.forEach(
    [...abandoned, ...expired],
    (file) =>
      fs.remove(file.path).pipe(
        Effect.as(file.size),
        Effect.orElseSucceed(() => 0),
      ),
    { concurrency: 8 },
  );

  return {
    removedFiles: removed.filter((size) => size > 0).length,
    removedBytes: removed.reduce((total, size) => total + size, 0),
    keptBytes,
  } satisfies PruneSummary;
});

/** Prunes the caches at startup and every hour for the lifetime of the layer. */
export const layer: Layer.Layer<
  never,
  never,
  MediaConfig.Service | FileSystem.FileSystem | Path.Path
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* MediaConfig.Service;
    const path = yield* Path.Path;
    const roots = cacheDirectories(config.dataDir, path);

    yield* prune(roots, config.cacheMaxBytes).pipe(
      Effect.tap((summary) =>
        summary.removedFiles === 0
          ? Effect.void
          : Effect.logInfo("CachePruner.pruned").pipe(Effect.annotateLogs({ ...summary })),
      ),
      Effect.repeat(Schedule.spaced(PRUNE_EVERY)),
      Effect.forkScoped,
    );
  }),
);
