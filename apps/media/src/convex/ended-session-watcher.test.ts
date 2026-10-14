import { assert, describe, it } from "@effect/vitest";
import { Context, Duration, Effect, Layer, Queue, Ref, Stream } from "effect";
import { TestClock } from "effect/testing";

import { PlaybackSessionId } from "@movies/contracts/ids";
import { PLAYBACK_TOKEN_LIFETIME_MS } from "@movies/contracts/playback-token";
import { EpochMillis } from "@movies/contracts/units";

import * as EndedSessions from "../playback/ended-sessions.ts";
import * as StreamSessions from "../playback/stream-sessions.ts";
import * as MemoryBackend from "../testing/memory-backend.ts";
import * as EndedSessionWatcher from "./ended-session-watcher.ts";

const NOW = 1_800_000_000_000;

const ended = (id: string, endedAt: number) => ({
  sessionId: PlaybackSessionId.make(id),
  endedAt: EpochMillis.make(endedAt),
});

describe("ended-session watcher", () => {
  it.effect("catches up on a token lifetime of ended sessions at startup, then follows", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);

      // Each subscription is one `after`; the test answers it through a queue.
      const asked = yield* Queue.unbounded<number>();

      const answers = new Map([
        [NOW - PLAYBACK_TOKEN_LIFETIME_MS, [ended("before-restart", NOW - 60_000)]],
        [NOW - 60_000, [ended("after-restart", NOW + 1000)]],
      ]);

      const closed = yield* Ref.make<ReadonlyArray<string>>([]);

      const streams = Layer.mock(StreamSessions.Service)({
        endSession: (sessionId) =>
          Ref.update(closed, (seen) => [...seen, sessionId]).pipe(Effect.as(1)),
      });

      const backend = MemoryBackend.layer(
        {},
        {
          "mediaService.endedSessions": ({ after }) =>
            Stream.fromEffect(Queue.offer(asked, after)).pipe(
              Stream.flatMap(() => Stream.make(answers.get(after) ?? [])),
              Stream.concat(Stream.never),
            ),
        },
      );

      const context = yield* Layer.build(
        EndedSessionWatcher.layer.pipe(
          Layer.provideMerge(EndedSessions.layer),
          Layer.provide(streams),
          Layer.provide(backend),
        ),
      );

      const sessions = Context.get(context, EndedSessions.Service);

      yield* TestClock.adjust(Duration.millis(1));

      assert.deepStrictEqual(yield* Queue.takeN(asked, 3), [
        NOW - PLAYBACK_TOKEN_LIFETIME_MS,
        NOW - 60_000,
        NOW + 1000,
      ]);
      assert.deepStrictEqual(yield* Ref.get(closed), ["before-restart", "after-restart"]);
      assert.isTrue(yield* sessions.isEnded(PlaybackSessionId.make("before-restart")));
      assert.isTrue(yield* sessions.isEnded(PlaybackSessionId.make("after-restart")));
      assert.isFalse(yield* sessions.isEnded(PlaybackSessionId.make("still-playing")));
    }),
  );
});
