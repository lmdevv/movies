/** Following a background job until it finishes, for `--wait`. */
import type { JobId } from "@movies/contracts/ids";
import type { Job } from "@movies/contracts/models/jobs";
import type { MoviesClient } from "@movies/sdk/effect";
import { Duration, Effect, Option, Ref, Stream } from "effect";

import { JobError } from "./cli-errors";
import { Output } from "./output";

const isFinished = (job: Job): boolean =>
  job.status === "succeeded" || job.status === "failed" || job.status === "cancelled";

/** `scan: running 120/500 (reading tags)` */
export const progressLine = (job: Job): string => {
  const { done, total, message } = job.progress;
  const count = total === null ? String(done) : `${String(done)}/${String(total)}`;
  const note = job.error ?? message;

  return `${job.kind}: ${job.status} ${count}${note === null ? "" : ` (${note})`}`;
};

/** How `--wait` behaves. */
export interface WaitOptions {
  /** Print progress lines on stderr when the job changes. */
  readonly progress: boolean;
  readonly timeout: Duration.Duration;
}

/**
 * Watches `jobs.get` until the job succeeds, fails, or is cancelled, printing progress to stderr
 * whenever it changes. Fails unless the job succeeded.
 */
export const waitForJob = Effect.fn("Jobs.wait")(function* (
  client: MoviesClient.Interface,
  jobId: JobId,
  options: WaitOptions,
) {
  const output = yield* Output;
  const lastLine = yield* Ref.make("");

  const report = (job: Job): Effect.Effect<void> =>
    Effect.gen(function* () {
      const line = progressLine(job);

      if (!options.progress || (yield* Ref.getAndSet(lastLine, line)) === line) return;

      yield* output.err(line);
    });

  const finished = yield* client
    .subscribe("jobs.get", { jobId })
    .pipe(
      Stream.tap(report),
      Stream.filter(isFinished),
      Stream.runHead,
      Effect.timeoutOption(options.timeout),
      Effect.map(Option.flatten),
    );

  if (Option.isNone(finished)) {
    return yield* new JobError({
      code: "timeout",
      jobId,
      message: `Job ${jobId} is still running after ${Duration.format(options.timeout)}; check it with movies jobs get ${jobId}`,
    });
  }

  const job = finished.value;

  if (job.status === "failed") {
    return yield* new JobError({
      code: "job_failed",
      jobId,
      message: `Job ${jobId} failed: ${job.error ?? "no error reported"}`,
    });
  }

  if (job.status === "cancelled") {
    return yield* new JobError({
      code: "job_cancelled",
      jobId,
      message: `Job ${jobId} was cancelled`,
    });
  }

  return job;
});

/**
 * Follows several jobs until each succeeds; `options.timeout` bounds the whole wait. Fails with the
 * first job that fails, is cancelled, or is still running when the time is up.
 */
export const waitForJobs = Effect.fn("Jobs.waitAll")(function* (
  client: MoviesClient.Interface,
  jobIds: ReadonlyArray<JobId>,
  options: WaitOptions,
) {
  // Concurrently, so every job's timeout starts now and together they bound the whole wait.
  return yield* Effect.forEach(jobIds, (jobId) => waitForJob(client, jobId, options), {
    concurrency: "unbounded",
  });
});
