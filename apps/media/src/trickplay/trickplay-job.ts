/**
 * Trickplay jobs: a scan found a file new or changed, or an admin asked for a library's scrub
 * thumbnails. The job resolves the file like playback does (inside `LIBRARY_ROOTS`, still on
 * disk), builds its sheets into the data folder, and records the manifest with
 * `mediaService:recordTrickplay`. These jobs have their own slots (`TRICKPLAY_CONCURRENCY`, one by
 * default), so a library's worth of them never holds up scans, metadata, or backups.
 *
 * A file that is gone, has no video, or from which ffmpeg picks no frames fails for good (Convex
 * keeps the failure until an admin asks again). Anything that may pass (an unreachable catalog, an
 * unreadable share, a full data folder, ffmpeg exiting with an error) returns the job to the queue,
 * up to five attempts. With `TRICKPLAY=off` this service runs no trickplay jobs: they wait, and run
 * once it is turned on.
 */
import { trickplayVersion } from "@movies/contracts/trickplay";
import { Bytes, EpochMillis } from "@movies/contracts/units";
import { Clock, Effect, FileSystem, Match, Option } from "effect";
import type { Path } from "effect";

import * as MediaBackend from "../convex/media-backend.ts";
import { JobFailed, type JobHandler } from "../jobs/job-worker.ts";
import * as MediaConfig from "../media-config.ts";
import type * as MediaTools from "../media/media-tools.ts";
import type * as FileResolver from "../playback/file-resolver.ts";
import { resolveInsideRoots } from "../playback/file-resolver.ts";
import { generate } from "./trickplay-generator.ts";
import * as TrickplayStore from "./trickplay-store.ts";

const count = (amount: number, noun: string): string =>
  `${String(amount)} ${noun}${amount === 1 ? "" : "s"}`;

type GenerateError = Effect.Error<ReturnType<typeof generate>>;

const generateFailure = Match.type<GenerateError | TrickplayStore.TrickplayStorageFailed>().pipe(
  Match.tagsExhaustive({
    TrickplayUnavailable: (error) => new JobFailed({ message: error.message, retry: false }),
    // A share that dropped, a full disk, or a killed process may pass; a corrupt file fails each
    // of its five attempts in seconds.
    MediaToolFailed: (error) => new JobFailed({ message: error.message, retry: true }),
    TrickplayStorageFailed: (error) => new JobFailed({ message: error.message, retry: true }),
  }),
);

/** The trickplay job handler, or none with `TRICKPLAY=off`, so the jobs wait for a service that runs them. */
export const handlers: Effect.Effect<
  ReadonlyArray<JobHandler>,
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
  const fs = yield* FileSystem.FileSystem;

  if (!enabled) return [];

  const handler = {
    kind: "trickplay",
    concurrency,
    run: Effect.fn("TrickplayJob.run")(function* (claim, workerId, reportProgress) {
      const { job } = claim;

      if (job.payload.kind !== "trickplay") {
        return yield* new JobFailed({ message: "This is not a trickplay job", retry: false });
      }

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

      // The resolver caches a file's size and time for playback; a file replaced moments ago must
      // be versioned by what ffmpeg is about to read.
      const info = yield* fs
        .stat(file.path)
        .pipe(
          Effect.mapError(
            () => new JobFailed({ message: "The file could not be read", retry: true }),
          ),
        );

      const sizeBytes = Number(info.size);

      const modifiedAtMs = Option.match(info.mtime, {
        onNone: () => 0,
        onSome: (date) => date.getTime(),
      });

      yield* reportProgress({ done: 0, total: 1, message: "Making thumbnails" });

      const started = yield* Clock.currentTimeMillis;
      const version = trickplayVersion(sizeBytes, modifiedAtMs);

      const manifest = yield* store
        .publish(fileId, version, (folder) => generate(file, version, interval, folder))
        .pipe(Effect.mapError(generateFailure));

      yield* backend
        .call("mediaService.recordTrickplay", {
          jobId: job.id,
          workerId,
          fileId,
          sizeBytes: Bytes.make(sizeBytes),
          mtimeMs: EpochMillis.make(Math.trunc(modifiedAtMs)),
          manifest,
        })
        .pipe(Effect.mapError((error) => new JobFailed({ message: error.message, retry: true })));

      yield* reportProgress({ done: 1, total: 1, message: null });

      const seconds = (((yield* Clock.currentTimeMillis) - started) / 1000).toFixed(1);

      return `${count(manifest.thumbnailCount, "thumbnail")} on ${count(manifest.sheetCount, "sheet")} in ${seconds} s`;
    }, Effect.provide(context)),
  } satisfies JobHandler;

  return [handler];
});
