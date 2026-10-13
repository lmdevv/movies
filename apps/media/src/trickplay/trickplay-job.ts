/**
 * Trickplay jobs: a scan found a file new or changed, or an admin asked for a library's scrub
 * thumbnails. The job resolves the file like playback does (inside `LIBRARY_ROOTS`, still on
 * disk), builds its sheets into the data folder, and records the manifest with
 * `mediaService:recordTrickplay`. These jobs have their own slots (`TRICKPLAY_CONCURRENCY`, one by
 * default), so a library's worth of them never holds up scans, metadata, or backups.
 *
 * A file that is gone, has no video, or that ffmpeg cannot read fails for good (Convex keeps the
 * failure until an admin asks again); an unreachable catalog, an unreadable share, or a full data
 * folder returns the job to the queue. With `TRICKPLAY=off` every job fails saying so.
 */
import { trickplayVersion } from "@movies/contracts/trickplay";
import { Bytes, EpochMillis } from "@movies/contracts/units";
import { Clock, Effect, Match } from "effect";
import type { FileSystem, Path } from "effect";

import * as MediaBackend from "../convex/media-backend.ts";
import { JobFailed, type JobHandler } from "../jobs/job-worker.ts";
import * as MediaConfig from "../media-config.ts";
import type * as MediaTools from "../media/media-tools.ts";
import type * as FileResolver from "../playback/file-resolver.ts";
import { resolveInsideRoots } from "../playback/file-resolver.ts";
import { generate } from "./trickplay-generator.ts";
import * as TrickplayStore from "./trickplay-store.ts";

const OFF = "Scrub thumbnails are turned off on this server (TRICKPLAY=off)";

const count = (amount: number, noun: string): string =>
  `${String(amount)} ${noun}${amount === 1 ? "" : "s"}`;

type GenerateError = Effect.Error<ReturnType<typeof generate>>;

const generateFailure = Match.type<GenerateError | TrickplayStore.TrickplayStorageFailed>().pipe(
  Match.tagsExhaustive({
    TrickplayUnavailable: (error) => new JobFailed({ message: error.message, retry: false }),
    MediaToolFailed: (error) => new JobFailed({ message: error.message, retry: false }),
    TrickplayStorageFailed: (error) => new JobFailed({ message: error.message, retry: true }),
  }),
);

/** The trickplay job handler. */
export const handler: Effect.Effect<
  JobHandler,
  never,
  | MediaBackend.Service
  | MediaConfig.Service
  | FileResolver.Service
  | TrickplayStore.Service
  | MediaTools.Service
  | FileSystem.FileSystem
  | Path.Path
> = Effect.gen(function* () {
  const backend = yield* MediaBackend.Service;
  const config = yield* MediaConfig.Service;
  const store = yield* TrickplayStore.Service;

  const context = yield* Effect.context<
    | MediaConfig.Service
    | FileResolver.Service
    | MediaTools.Service
    | FileSystem.FileSystem
    | Path.Path
  >();

  const { interval, concurrency, enabled } = config.trickplay;

  return {
    kind: "trickplay",
    concurrency,
    run: Effect.fn("TrickplayJob.run")(function* (claim, workerId, reportProgress) {
      const { job } = claim;

      if (job.payload.kind !== "trickplay") {
        return yield* new JobFailed({ message: "This is not a trickplay job", retry: false });
      }

      if (!enabled) return yield* new JobFailed({ message: OFF, retry: false });
      const { fileId } = job.payload;

      const file = yield* resolveInsideRoots(fileId).pipe(
        Effect.catchTags({
          MediaFileNotFound: () =>
            Effect.fail(
              new JobFailed({ message: "This file is missing or was removed", retry: false }),
            ),
          FileResolverUnavailable: (error) =>
            Effect.fail(new JobFailed({ message: error.message, retry: true })),
        }),
      );

      yield* reportProgress({ done: 0, total: 1, message: "Making thumbnails" });

      const started = yield* Clock.currentTimeMillis;
      const version = trickplayVersion(file.sizeBytes, file.modifiedAtMs);

      const manifest = yield* store
        .publish(fileId, version, (folder) => generate(file, version, interval, folder))
        .pipe(Effect.mapError(generateFailure));

      yield* backend
        .call("mediaService.recordTrickplay", {
          jobId: job.id,
          workerId,
          fileId,
          sizeBytes: Bytes.make(file.sizeBytes),
          mtimeMs: EpochMillis.make(Math.trunc(file.modifiedAtMs)),
          manifest,
        })
        .pipe(Effect.mapError((error) => new JobFailed({ message: error.message, retry: true })));

      yield* reportProgress({ done: 1, total: 1, message: null });

      const seconds = (((yield* Clock.currentTimeMillis) - started) / 1000).toFixed(1);

      return `${count(manifest.thumbnailCount, "thumbnail")} on ${count(manifest.sheetCount, "sheet")} in ${seconds} s`;
    }, Effect.provide(context)),
  } satisfies JobHandler;
});
