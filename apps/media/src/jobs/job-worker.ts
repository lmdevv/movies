/**
 * Runs background jobs from Convex. The worker subscribes to `mediaService:pendingJobs`, claims
 * jobs it has a handler for with a one-minute lease, renews the lease every fifteen seconds with
 * the handler's progress, and completes or fails the job. A renewal that reports the job
 * cancelled, or that finds the lease taken by another worker, interrupts the handler. A worker
 * that dies stops renewing; Convex's cron returns the job to the queue once the lease expires and
 * another worker claims it, so handlers must tolerate running a job again (scans are idempotent).
 *
 * Handlers are registered by job kind (`layer(handlers)`); a kind without a handler is left for
 * another worker. Expected handler failures carry whether the job should be retried; defects fail
 * the job without a retry.
 */
import { hostname } from "node:os";

import type { JobId } from "@movies/contracts/ids";
import type { Job, JobKind, JobProgress } from "@movies/contracts/models/jobs";
import type { ClaimedJob } from "@movies/contracts/models/scan";
import {
  Cause,
  Crypto,
  Data,
  Duration,
  Effect,
  Layer,
  Option,
  Predicate,
  Queue,
  Ref,
  Schedule,
  Schema,
  Stream,
} from "effect";

import * as MediaBackend from "../convex/media-backend.ts";

/** A handler's expected failure, recorded on the job. */
export class JobFailed extends Schema.TaggedError<JobFailed>()("JobFailed", {
  /** Shown to admins on the job; no paths outside the library or secrets. */
  message: Schema.String,
  /** Return the job to the queue (up to five attempts in all) instead of failing it for good. */
  retry: Schema.Boolean,
}) {}

/** Runs the jobs of one kind. */
export interface JobHandler {
  readonly kind: JobKind;
  /**
   * Jobs of this kind run in their own slots, this many at once, instead of sharing the worker's
   * slots with other kinds; for long, low-priority work such as scrub thumbnails.
   */
  readonly concurrency?: number;
  /**
   * Runs a claimed job and returns the message recorded when it succeeds. `workerId` holds the
   * lease, for functions that require it; `reportProgress` replaces what the next lease renewal
   * reports.
   */
  readonly run: (
    claim: ClaimedJob,
    workerId: string,
    reportProgress: (progress: JobProgress) => Effect.Effect<void>,
  ) => Effect.Effect<string, JobFailed>;
}

/** How a held job ended. */
type JobEnd = Data.TaggedEnum<{
  Finished: { readonly message: string };
  Failed: { readonly error: JobFailed };
  Cancelled: {};
  LeaseLost: {};
}>;

const JobEnd = Data.taggedEnum<JobEnd>();

const LEASE_MS = 60_000;

const RENEW_EVERY = Duration.seconds(15);

/** Jobs of kinds without their own slots run at the same time by one worker. */
const MAX_RUNNING = 2;

/** How often pending jobs are looked at again without a subscription update. */
const RESCAN_EVERY = Duration.seconds(30);

const EMPTY_PROGRESS: JobProgress = { done: 0, total: null, message: null };

/** Builds the worker; its fibers live as long as the layer's scope. */
const make = Effect.fn("JobWorker.make")(function* (handlers: ReadonlyArray<JobHandler>) {
  const backend = yield* MediaBackend.Service;
  const crypto = yield* Crypto.Crypto;
  const suffix = Buffer.from(yield* crypto.randomBytes(6).pipe(Effect.orDie)).toString("hex");
  const workerId = `${hostname()}:${String(process.pid)}:${suffix}`;
  const byKind = new Map(handlers.map((handler) => [handler.kind, handler]));
  const pending = yield* Ref.make<ReadonlyArray<Job>>([]);
  /** Running jobs and the slot pool each one holds: its kind's own, or the shared one. */
  const running = yield* Ref.make<ReadonlyMap<JobId, JobKind | null>>(new Map());

  /** The pool a kind runs in, and how many of its jobs may run at once. */
  const poolOf = (handler: JobHandler): readonly [JobKind | null, number] =>
    handler.concurrency === undefined ? [null, MAX_RUNNING] : [handler.kind, handler.concurrency];

  const wake = yield* Queue.sliding<void>(1);

  /** Renews the lease until the job is cancelled or the lease is lost. */
  const keepLease = (jobId: JobId, progress: Ref.Ref<JobProgress>): Effect.Effect<JobEnd> =>
    Effect.gen(function* () {
      for (;;) {
        yield* Effect.sleep(RENEW_EVERY);

        const renewed = yield* backend
          .call("mediaService.renewLease", {
            jobId,
            workerId,
            leaseMs: LEASE_MS,
            progress: yield* Ref.get(progress),
          })
          .pipe(
            Effect.map((result): Option.Option<JobEnd> =>
              result.cancelled ? Option.some(JobEnd.Cancelled()) : Option.none(),
            ),
            Effect.catchTags({
              Conflict: () => Effect.succeedSome<JobEnd>(JobEnd.LeaseLost()),
              NotFound: () => Effect.succeedSome<JobEnd>(JobEnd.LeaseLost()),
            }),
            Effect.catch((error) =>
              Effect.logWarning("JobWorker.renew_failed", error).pipe(
                Effect.as(Option.none<JobEnd>()),
              ),
            ),
          );

        if (Option.isSome(renewed)) return renewed.value;
      }
    });

  /** Completes or fails a held job; a lost lease means another worker owns the outcome. */
  const settle = Effect.fn("JobWorker.settle")(function* (jobId: JobId, end: JobEnd) {
    const write = JobEnd.$match(end, {
      Finished: ({ message }) =>
        backend.call("mediaService.completeJob", { jobId, workerId, message }),
      Failed: ({ error }) =>
        backend.call("mediaService.failJob", {
          jobId,
          workerId,
          error: error.message,
          retry: error.retry,
        }),
      Cancelled: () => Effect.succeed({ ok: true as const }),
      LeaseLost: () => Effect.succeed({ ok: true as const }),
    });

    yield* write.pipe(
      Effect.retry({
        while: (error) => Predicate.isTagged(error, "TransportError"),
        schedule: Schedule.exponential("500 millis").pipe(Schedule.upTo({ times: 5 })),
      }),
      Effect.catch((error) => Effect.logWarning("JobWorker.settle_failed", error)),
    );

    yield* Effect.logInfo("JobWorker.job_ended").pipe(
      Effect.annotateLogs({
        outcome: JobEnd.$match(end, {
          Finished: () => "succeeded",
          Failed: ({ error }) => (error.retry ? "retrying" : "failed"),
          Cancelled: () => "cancelled",
          LeaseLost: () => "lease-lost",
        }),
      }),
    );
  });

  const runJob = Effect.fn("JobWorker.runJob")(
    function* (job: Job, handler: JobHandler) {
      const claimed = yield* backend
        .call("mediaService.claimJob", { jobId: job.id, workerId, leaseMs: LEASE_MS })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("JobWorker.claim_failed", error).pipe(Effect.as(null)),
          ),
        );

      if (claimed === null) return;
      yield* Effect.logInfo("JobWorker.claimed").pipe(Effect.annotateLogs({ kind: job.kind }));
      const progress = yield* Ref.make(EMPTY_PROGRESS);

      const work = handler
        .run(claimed, workerId, (next) => Ref.set(progress, next))
        .pipe(
          Effect.map((message) => JobEnd.Finished({ message })),
          Effect.catchTag("JobFailed", (error) => Effect.succeed(JobEnd.Failed({ error }))),
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterrupts(cause),
            (cause) =>
              Effect.logError("JobWorker.handler_defect", cause).pipe(
                Effect.as(
                  JobEnd.Failed({
                    error: new JobFailed({
                      message: "The job stopped on an internal error",
                      retry: false,
                    }),
                  }),
                ),
              ),
          ),
        );

      const end = yield* Effect.raceFirst(work, keepLease(job.id, progress));

      // The last renewal may predate the end of the work; leave the final progress on the job.
      if (JobEnd.$is("Finished")(end) || JobEnd.$is("Failed")(end)) {
        yield* backend
          .call("mediaService.renewLease", {
            jobId: job.id,
            workerId,
            leaseMs: LEASE_MS,
            progress: yield* Ref.get(progress),
          })
          .pipe(Effect.ignore);
      }

      yield* settle(job.id, end);
    },
    (effect, job) => effect.pipe(Effect.annotateLogs({ jobId: job.id, workerId })),
  );

  /** Claims every pending job this worker can run while its pool has a free slot. */
  const dispatch = Effect.gen(function* () {
    for (const job of yield* Ref.get(pending)) {
      const handler = byKind.get(job.kind);

      if (handler === undefined) continue;
      const [pool, limit] = poolOf(handler);

      const start = yield* Ref.modify(running, (current) => {
        const inPool = [...current.values()].filter((held) => held === pool).length;

        return current.has(job.id) || inPool >= limit
          ? [false, current]
          : [true, new Map(current).set(job.id, pool)];
      });

      if (!start) continue;

      yield* runJob(job, handler).pipe(
        Effect.ensuring(
          Ref.update(running, (current) => {
            const next = new Map(current);
            next.delete(job.id);

            return next;
          }).pipe(Effect.andThen(Queue.offer(wake, undefined))),
        ),
        Effect.forkScoped,
      );
    }
  });

  yield* backend.subscribe("mediaService.pendingJobs", {}).pipe(
    Stream.runForEach((jobs) =>
      Ref.set(pending, jobs).pipe(Effect.andThen(Queue.offer(wake, undefined))),
    ),
    Effect.forkScoped,
  );

  yield* Queue.offer(wake, undefined).pipe(
    Effect.repeat(Schedule.spaced(RESCAN_EVERY)),
    Effect.forkScoped,
  );

  yield* Stream.fromQueue(wake).pipe(
    Stream.runForEach(() => dispatch),
    Effect.forkScoped,
  );
  yield* Effect.logInfo("JobWorker.ready").pipe(Effect.annotateLogs({ workerId }));
});

/** Runs jobs with `handlers` for the lifetime of the layer. */
export const layer = <R>(
  handlers: Effect.Effect<ReadonlyArray<JobHandler>, never, R>,
): Layer.Layer<never, never, R | MediaBackend.Service | Crypto.Crypto> =>
  Layer.effectDiscard(Effect.flatMap(handlers, make));
