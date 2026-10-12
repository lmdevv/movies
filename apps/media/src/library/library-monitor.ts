/**
 * Keeps libraries in sync with disk. File change events are hints: a debounced burst triggers
 * an incremental scan. A periodic incremental scan is authoritative and covers network shares
 * that send no events, and a watcher that cannot start (an unmounted share) is retried at the
 * same cadence. Scans of one library never overlap.
 */
import { Duration, Effect, FileSystem, Layer, Schedule, Semaphore, Stream } from "effect";

import type { LibraryId } from "../ids.ts";
import * as MediaConfig from "../media-config.ts";
import * as LibraryScanner from "./library-scanner.ts";

/** A library folder to keep in sync. */
export interface MonitoredLibrary {
  readonly libraryId: LibraryId;
  readonly root: string;
}

/** How quickly changes are picked up. */
interface MonitorTiming {
  /** Quiet period after the last change event before scanning. */
  readonly debounce: Duration.Duration;
  readonly reconcileInterval: Duration.Duration;
}

const DEFAULT_DEBOUNCE = Duration.seconds(3);

/** Watches and reconciles one library until interrupted. */
const monitorLibrary = Effect.fn("LibraryMonitor.monitor")(
  function* (library: MonitoredLibrary, timing: MonitorTiming) {
    const scanner = yield* LibraryScanner.Service;
    const fs = yield* FileSystem.FileSystem;
    const lock = yield* Semaphore.make(1);

    const scan = (reason: "startup" | "change" | "reconcile") =>
      lock.withPermits(1)(
        scanner
          .scan({ libraryId: library.libraryId, root: library.root, mode: "incremental" })
          .pipe(
            Effect.tap((summary) =>
              Effect.logInfo("LibraryMonitor.scanned").pipe(
                Effect.annotateLogs({
                  reason,
                  discovered: summary.discovered,
                  processed: summary.processed,
                  unchanged: summary.unchanged,
                  missing: summary.missing,
                  failed: summary.failed,
                }),
              ),
            ),
            Effect.tapError((error) =>
              Effect.logWarning("LibraryMonitor.scan_failed", error).pipe(
                Effect.annotateLogs({ reason }),
              ),
            ),
            Effect.ignore,
          ),
      );

    const watch = fs.watch(library.root, { recursive: true }).pipe(
      Stream.debounce(timing.debounce),
      Stream.runForEach(() => scan("change")),
      Effect.tapError((error) => Effect.logWarning("LibraryMonitor.watch_failed", error)),
      Effect.retry(Schedule.spaced(timing.reconcileInterval)),
      Effect.ignore,
    );

    yield* scan("startup");

    yield* Effect.all(
      [watch, scan("reconcile").pipe(Effect.delay(timing.reconcileInterval), Effect.forever)],
      { concurrency: "unbounded", discard: true },
    );
  },
  (effect, library) => effect.pipe(Effect.annotateLogs({ libraryId: library.libraryId })),
);

/** Monitors `libraries` for the lifetime of the layer. */
export const layer = (
  libraries: ReadonlyArray<MonitoredLibrary>,
  debounce: Duration.Duration = DEFAULT_DEBOUNCE,
): Layer.Layer<
  never,
  never,
  LibraryScanner.Service | FileSystem.FileSystem | MediaConfig.Service
> =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const config = yield* MediaConfig.Service;
      const timing = { debounce, reconcileInterval: config.reconcileInterval };

      yield* Effect.forEach(
        libraries,
        (library) => monitorLibrary(library, timing).pipe(Effect.forkScoped),
        {
          discard: true,
        },
      );
    }),
  );
