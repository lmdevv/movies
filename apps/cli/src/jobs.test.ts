import { JobId } from "@movies/contracts/ids";
import { ConvexTransport, Movies, MoviesClient, TokenStorage } from "@movies/sdk/effect";
import { Clock, Context, Duration, Effect, Fiber, Layer, Option, Predicate, Stream } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import { waitForJobs } from "./jobs";
import { Output } from "./output";

/** A scan job as `jobs.get` returns it on the wire. */
const job = (id: string, status: "running" | "succeeded") => ({
  id,
  kind: "scan",
  status,
  payload: { kind: "scan", libraryId: "library", mode: "full" },
  progress: { done: 0, total: null, message: null },
  error: null,
  requestedBy: null,
  attempts: 1,
  createdAt: 0,
  startedAt: 0,
  finishedAt: null,
});

/**
 * A Convex connection whose `jobs.get` reports each job running until its finish time on the
 * clock, then succeeded, however late the subscription starts, as the server does.
 */
const jobsTransport = (finishAt: ReadonlyMap<string, number>): ConvexTransport.Interface =>
  ConvexTransport.ConvexTransport.of({
    call: () => Effect.never,
    setAuth: () => Effect.void,
    subscribe: (_path, args) => {
      const id = Predicate.isString(args["jobId"]) ? args["jobId"] : "";
      const finish = finishAt.get(id) ?? Number.POSITIVE_INFINITY;

      return Stream.make(job(id, "running")).pipe(
        Stream.concat(
          Stream.fromEffect(
            Effect.flatMap(Clock.currentTimeMillis, (now) =>
              Effect.as(Effect.sleep(Duration.millis(finish - now)), job(id, "succeeded")),
            ),
          ),
        ),
        Stream.concat(Stream.never),
      );
    },
  });

const silent = Output.of({ out: () => Effect.void, err: () => Effect.void });

/** Waits for `jobIds` with a 10-second timeout while the test clock runs 20 seconds. */
const waitWithClock = (finishAt: ReadonlyMap<string, number>, jobIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      Layer.merge(
        TestClock.layer(),
        Movies.layerWithTransport({
          convexUrl: "http://127.0.0.1:9",
          mediaUrl: Option.none(),
        }).pipe(
          Layer.provide(Layer.succeed(ConvexTransport.ConvexTransport, jobsTransport(finishAt))),
          Layer.provide(TokenStorage.layerMemory),
        ),
      ),
    );

    return yield* Effect.gen(function* () {
      const fiber = yield* waitForJobs(
        Context.get(context, MoviesClient.MoviesClient),
        jobIds.map((id) => JobId.make(id)),
        { progress: false, timeout: Duration.seconds(10) },
      ).pipe(Effect.result, Effect.forkChild);

      yield* TestClock.adjust(Duration.seconds(20));

      return yield* Fiber.join(fiber);
    }).pipe(Effect.provideContext(context));
  }).pipe(Effect.scoped, Effect.provideService(Output, silent), Effect.runPromise);

describe("waiting for several jobs", () => {
  it("returns every job once all of them succeed", async () => {
    const result = await waitWithClock(
      new Map([
        ["job-a", 6000],
        ["job-b", 9000],
      ]),
      ["job-a", "job-b"],
    );

    expect(result).toMatchObject({
      _tag: "Success",
      success: [
        { id: "job-a", status: "succeeded" },
        { id: "job-b", status: "succeeded" },
      ],
    });
  });

  it("bounds the whole wait by --timeout, not each job", async () => {
    const result = await waitWithClock(
      new Map([
        ["job-a", 6000],
        ["job-b", 12_000],
      ]),
      ["job-a", "job-b"],
    );

    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "JobError", code: "timeout", jobId: "job-b" },
    });
  });
});
