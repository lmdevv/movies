import { assert, describe, it } from "@effect/vitest";
import { Context, Duration, Effect, Fiber, Layer, Queue, Stream } from "effect";
import { TestClock } from "effect/testing";

import { PlaybackSessionId } from "@movies/contracts/ids";

import * as ConvexSessionReports from "../convex/convex-session-reports.ts";
import * as TestConvex from "../testing/test-convex.ts";
import * as EndedSessions from "./ended-sessions.ts";
import * as SessionReports from "./session-reports.ts";
import { SessionReport } from "./stream-liveness.ts";

const sessionId = (id: string) => PlaybackSessionId.make(id);

const overConvex = EndedSessions.layer.pipe(
  Layer.provide(ConvexSessionReports.layer),
  Layer.provideMerge(TestConvex.layer),
);

describe("ended sessions", () => {
  it.effect("hears an end from the session itself, whatever its stamp", () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(overConvex);
      const convex = Context.get(context, TestConvex.Service);
      const ended = Context.get(context, EndedSessions.Service);

      yield* TestClock.setTime(10_000);
      yield* convex.report("seen", "playing", 0);
      yield* convex.report("late", "playing", 0);

      assert.isFalse(yield* ended.isEnded(sessionId("seen")));
      assert.isFalse(yield* ended.isEnded(sessionId("late")));

      yield* convex.end("seen");

      // A restore or a clock step puts the clock back, so this end is stamped before one seen.
      yield* TestClock.setTime(5_000);
      yield* convex.end("late");

      assert.isTrue(yield* ended.isEnded(sessionId("seen")));
      assert.isTrue(yield* ended.isEnded(sessionId("late")));
    }),
  );

  it.effect("counts a session the owner has no record of as ended", () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(overConvex);
      const convex = Context.get(context, TestConvex.Service);
      const ended = Context.get(context, EndedSessions.Service);

      yield* convex.report("known", "paused", 0);

      assert.isTrue(yield* ended.isEnded(sessionId("deleted-or-never-created")));
      assert.isFalse(yield* ended.isEnded(sessionId("known")));
    }),
  );

  it.effect("waits five seconds for a first answer, then answers no until one comes", () =>
    Effect.gen(function* () {
      const answers = yield* Queue.unbounded<SessionReport>();
      const asked: Array<string> = [];

      const reports = Layer.succeed(
        SessionReports.Service,
        SessionReports.Service.of({
          follow: (followed) => {
            asked.push(followed);

            return Stream.fromQueue(answers);
          },
        }),
      );

      const context = yield* Layer.build(EndedSessions.layer.pipe(Layer.provide(reports)));
      const ended = Context.get(context, EndedSessions.Service);
      const quiet = sessionId("quiet");

      const first = yield* Effect.forkChild(ended.isEnded(quiet));
      const second = yield* Effect.forkChild(ended.isEnded(quiet));

      yield* TestClock.adjust(Duration.millis(4_999));

      assert.isUndefined(first.pollUnsafe(), "still waiting for the answer");

      yield* TestClock.adjust(Duration.millis(1));

      assert.isFalse(yield* Fiber.join(first));
      assert.isFalse(yield* Fiber.join(second));
      assert.isFalse(yield* ended.isEnded(quiet), "no second wait");

      yield* Queue.offer(answers, SessionReport.Ended());

      assert.isTrue(
        yield* Effect.yieldNow.pipe(
          Effect.andThen(ended.isEnded(quiet)),
          Effect.repeat({ until: (answer) => answer, times: 100 }),
        ),
      );
      assert.deepStrictEqual(asked, [quiet], "one follow for every question about a session");
    }),
  );
});
