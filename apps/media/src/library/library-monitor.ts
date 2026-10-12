/**
 * Keeps libraries in sync with disk. File change events are hints: a debounced burst triggers
 * an incremental scan. A periodic incremental scan is authoritative and covers network shares
 * that send no events, and a watcher that cannot start (an unmounted share) is retried at the
 * same cadence. Scans of one library never overlap, whether a watcher, the reconciliation, or a
 * scan job started them.
 *
 * The set of libraries comes from the caller: the approved roots in standalone mode, or the
 * Convex `libraries` subscription. A library with a folder outside `LIBRARY_ROOTS` is scanned
 * once, which reports the refusal, and is not watched.
 */
import type { LibraryId } from "@movies/contracts/ids";
import {
  Context,
  Duration,
  Effect,
  FiberMap,
  FileSystem,
  Layer,
  Ref,
  Schedule,
  Semaphore,
  Stream,
} from "effect";

import * as MediaConfig from "../media-config.ts";
import * as LibraryScanner from "./library-scanner.ts";

/** A library and the folders to keep in sync. */
export interface MonitoredLibrary {
  readonly libraryId: LibraryId;
  /** Absolute folder paths, as the library records them. */
  readonly roots: ReadonlyArray<string>;
}

/** Why a scan runs, for logs. */
type ScanReason = "startup" | "change" | "reconcile" | "job";

/** Scans and watches libraries. */
export interface Interface {
  /**
   * Scans every folder of `library` in order, after any scan of the same library already
   * running. Stops at the first folder that fails, so no folder's files are wrongly marked missing.
   */
  readonly scan: (
    library: MonitoredLibrary,
    mode: LibraryScanner.ScanMode,
    reason: ScanReason,
  ) => Effect.Effect<ReadonlyArray<LibraryScanner.ScanSummary>, LibraryScanner.ScanError>;
  /** Watches and reconciles exactly `libraries`, stopping libraries no longer listed. */
  readonly track: (libraries: ReadonlyArray<MonitoredLibrary>) => Effect.Effect<void>;
}

/** The library monitor. */
export class Service extends Context.Service<Service, Interface>()(
  "@movies/media/LibraryMonitor",
) {}

/** How quickly changes are picked up. */
interface MonitorTiming {
  /** Quiet period after the last change event before scanning. */
  readonly debounce: Duration.Duration;
  readonly reconcileInterval: Duration.Duration;
}

const DEFAULT_DEBOUNCE = Duration.seconds(3);

/** One watcher per library and folder set; a change of folders restarts it. */
const keyOf = (library: MonitoredLibrary): string =>
  `${library.libraryId}\u0000${library.roots.join("\u0000")}`;

/** Builds the monitor; watchers live as long as the layer. */
const make = Effect.fn("LibraryMonitor.make")(function* (debounce: Duration.Duration) {
  const scanner = yield* LibraryScanner.Service;
  const fs = yield* FileSystem.FileSystem;
  const config = yield* MediaConfig.Service;
  const timing: MonitorTiming = { debounce, reconcileInterval: config.reconcileInterval };
  const locks = yield* Ref.make<ReadonlyMap<LibraryId, Semaphore.Semaphore>>(new Map());
  const watchers = yield* FiberMap.make<string>();
  const tracked = yield* Ref.make<ReadonlySet<string>>(new Set());

  const lockOf = Effect.fnUntraced(function* (libraryId: LibraryId) {
    const fresh = yield* Semaphore.make(1);

    return yield* Ref.modify(locks, (current) => {
      const existing = current.get(libraryId);

      return existing === undefined
        ? [fresh, new Map(current).set(libraryId, fresh)]
        : [existing, current];
    });
  });

  const scan = Effect.fn("LibraryMonitor.scan")(
    function* (library: MonitoredLibrary, mode: LibraryScanner.ScanMode, reason: ScanReason) {
      const lock = yield* lockOf(library.libraryId);

      const summaries = yield* lock.withPermits(1)(
        Effect.forEach(library.roots, (root) =>
          scanner.scan({ libraryId: library.libraryId, root, mode }),
        ),
      );

      yield* Effect.logInfo("LibraryMonitor.scanned").pipe(
        Effect.annotateLogs({
          reason,
          discovered: summaries.reduce((total, summary) => total + summary.discovered, 0),
          processed: summaries.reduce((total, summary) => total + summary.processed, 0),
          unchanged: summaries.reduce((total, summary) => total + summary.unchanged, 0),
          missing: summaries.reduce((total, summary) => total + summary.missing, 0),
          failed: summaries.reduce((total, summary) => total + summary.failed, 0),
        }),
      );

      return summaries;
    },
    (effect, library, _mode, reason) =>
      effect.pipe(
        Effect.tapError((error) =>
          Effect.logWarning("LibraryMonitor.scan_failed", error).pipe(
            Effect.annotateLogs({ reason }),
          ),
        ),
        Effect.annotateLogs({ libraryId: library.libraryId }),
      ),
  );

  /** Watches and reconciles one library until interrupted. */
  const monitor = Effect.fn("LibraryMonitor.monitor")(
    function* (library: MonitoredLibrary) {
      const approved = yield* scan(library, "incremental", "startup").pipe(
        Effect.as(true),
        Effect.catchTag("LibraryRootNotApproved", () => Effect.succeed(false)),
        Effect.orElseSucceed(() => true),
      );

      if (!approved) return;

      const rescan = (reason: "change" | "reconcile") =>
        scan(library, "incremental", reason).pipe(Effect.ignore);

      const watch = (root: string) =>
        fs.watch(root, { recursive: true }).pipe(
          Stream.debounce(timing.debounce),
          Stream.runForEach(() => rescan("change")),
          Effect.tapError((error) => Effect.logWarning("LibraryMonitor.watch_failed", error)),
          Effect.retry(Schedule.spaced(timing.reconcileInterval)),
          Effect.ignore,
        );

      yield* Effect.all(
        [
          ...library.roots.map(watch),
          rescan("reconcile").pipe(Effect.delay(timing.reconcileInterval), Effect.forever),
        ],
        { concurrency: "unbounded", discard: true },
      );
    },
    (effect, library) => effect.pipe(Effect.annotateLogs({ libraryId: library.libraryId })),
  );

  const track = Effect.fn("LibraryMonitor.track")(function* (
    libraries: ReadonlyArray<MonitoredLibrary>,
  ) {
    const wanted = new Map(libraries.map((library) => [keyOf(library), library]));
    const previous = yield* Ref.getAndSet(tracked, new Set(wanted.keys()));

    yield* Effect.forEach(
      [...previous].filter((key) => !wanted.has(key)),
      (key) => FiberMap.remove(watchers, key),
      { discard: true },
    );

    yield* Effect.forEach(
      [...wanted].filter(([key]) => !previous.has(key)),
      ([key, library]) => FiberMap.run(watchers, key, monitor(library), { onlyIfMissing: true }),
      { discard: true },
    );
  });

  return Service.of({ scan, track });
});

/** The monitor with nothing tracked yet. `debounce` is the quiet period before a change scan. */
export const layer = (
  debounce: Duration.Duration = DEFAULT_DEBOUNCE,
): Layer.Layer<
  Service,
  never,
  LibraryScanner.Service | FileSystem.FileSystem | MediaConfig.Service
> => Layer.effect(Service, make(debounce));

/** Tracks a fixed set of libraries for the lifetime of the layer, as standalone mode does. */
export const layerTracking = (
  libraries: ReadonlyArray<MonitoredLibrary>,
): Layer.Layer<never, never, Service> =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const monitor = yield* Service;

      yield* monitor.track(libraries);
    }),
  );
