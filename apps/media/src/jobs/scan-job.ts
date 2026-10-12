/**
 * Scan jobs: an admin added a library, changed its folders, or asked for a scan. The scan runs
 * through the library monitor, so it never overlaps a watcher's scan of the same library. A
 * `full` scan re-reads every file (picking up edited NFO files and artwork); a `quick` scan skips
 * files whose size and modification time did not change. Progress is the scanner's counters.
 *
 * A folder outside `LIBRARY_ROOTS` fails the job for good with the scanner's message; an
 * unreadable folder or an unreachable Convex returns the job to the queue.
 */
import { Duration, Effect, Match, Option, Schedule } from "effect";

import * as ScanProgress from "../convex/convex-library-sink.ts";
import * as LibraryMonitor from "../library/library-monitor.ts";
import type { ScanError, ScanSummary } from "../library/library-scanner.ts";
import { JobFailed, type JobHandler } from "./job-worker.ts";

const PROGRESS_EVERY = Duration.seconds(2);

const failure = Match.type<ScanError>().pipe(
  Match.tagsExhaustive({
    LibraryRootNotApproved: (error) => new JobFailed({ message: error.message, retry: false }),
    LibraryRootUnavailable: (error) => new JobFailed({ message: error.message, retry: true }),
    LibraryFolderUnreadable: (error) => new JobFailed({ message: error.message, retry: true }),
    LibrarySinkFailed: (error) => new JobFailed({ message: error.message, retry: true }),
  }),
);

const describe = (summaries: ReadonlyArray<ScanSummary>): string => {
  const total = (pick: (summary: ScanSummary) => number) =>
    summaries.reduce((sum, summary) => sum + pick(summary), 0);

  return [
    `${String(total((s) => s.discovered))} files`,
    `${String(total((s) => s.processed))} new or changed`,
    `${String(total((s) => s.unchanged))} unchanged`,
    `${String(total((s) => s.missing))} missing`,
    `${String(total((s) => s.failed))} unreadable`,
  ].join(", ");
};

/** The scan job handler. */
export const handler: Effect.Effect<
  JobHandler,
  never,
  LibraryMonitor.Service | ScanProgress.ScanProgress
> = Effect.gen(function* () {
  const monitor = yield* LibraryMonitor.Service;
  const progress = yield* ScanProgress.ScanProgress;

  return {
    kind: "scan",
    run: Effect.fn("ScanJob.run")(function* (claim, _workerId, reportProgress) {
      const { library } = claim;
      const { payload } = claim.job;

      if (library === null || payload.kind !== "scan") {
        return yield* new JobFailed({ message: "This library was removed", retry: false });
      }

      const publish = progress.latest(library.id).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (latest) =>
              reportProgress({
                done: latest.processed + latest.unchanged + latest.failed,
                total: latest.discovered,
                message: latest.phase,
              }),
          }),
        ),
      );

      const summaries = yield* monitor
        .scan(
          { libraryId: library.id, roots: library.roots },
          payload.mode === "full" ? "full" : "incremental",
          "job",
        )
        .pipe(
          Effect.mapError(failure),
          Effect.raceFirst(
            publish.pipe(
              Effect.repeat(Schedule.spaced(PROGRESS_EVERY)),
              Effect.andThen(Effect.never),
            ),
          ),
        );

      yield* publish;

      return describe(summaries);
    }),
  } satisfies JobHandler;
});
