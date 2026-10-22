import { Effect, Match } from "effect";

import * as MediaBackend from "../convex/media-backend.ts";
import { JobFailed, type JobHandler } from "../jobs/job-worker.ts";
import * as Backups from "./backups.ts";

const STEPS = 3;

const failure = Match.type<Backups.CreateError>().pipe(
  Match.tagsExhaustive({
    BackupBusy: (error) => new JobFailed({ message: error.message, retry: true }),
    BackupFolderFailed: (error) => new JobFailed({ message: error.message, retry: true }),
    ConvexCliFailed: (error) => new JobFailed({ message: error.message, retry: true }),
    ConvexCliUnavailable: (error) => new JobFailed({ message: error.message, retry: false }),
  }),
);

const megabytes = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** The backup job handler. */
export const handler: Effect.Effect<JobHandler, never, Backups.Service | MediaBackend.Service> =
  Effect.gen(function* () {
    const backups = yield* Backups.Service;
    const backend = yield* MediaBackend.Service;

    return {
      kind: "backup",
      run: Effect.fn("BackupJob.run")(function* (claim, workerId, reportProgress) {
        const { job } = claim;

        if (job.payload.kind !== "backup") {
          return yield* new JobFailed({ message: "This is not a backup job", retry: false });
        }

        yield* reportProgress({ done: 0, total: STEPS, message: "Exporting" });
        const archive = yield* backups.create(job.payload.trigger).pipe(Effect.mapError(failure));
        yield* reportProgress({ done: 1, total: STEPS, message: "Recording" });

        yield* backend
          .call("mediaService.recordBackup", {
            jobId: job.id,
            workerId,
            fileName: archive.fileName,
            sizeBytes: archive.sizeBytes,
          })
          .pipe(Effect.mapError((error) => new JobFailed({ message: error.message, retry: true })));

        yield* reportProgress({ done: 2, total: STEPS, message: "Pruning" });

        const pruned = yield* backups.prune(archive.fileName).pipe(
          Effect.map((removed) => `removed ${String(removed.length)} past retention`),
          Effect.catch((error) =>
            Effect.logWarning("BackupJob.prune_failed", error).pipe(
              Effect.as(`pruning failed: ${error.message}`),
            ),
          ),
        );

        yield* reportProgress({ done: STEPS, total: STEPS, message: null });

        return `${archive.fileName}, ${megabytes(archive.sizeBytes)}; ${pruned}`;
      }),
    } satisfies JobHandler;
  });
