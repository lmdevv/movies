import type { FunctionPath } from "@movies/contracts/command";
import { StartedPlayback } from "@movies/contracts/models/playback";
import { Effect, Exit, Fiber, Layer, Ref, Schema, Scope, Stream } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import * as ConvexTransport from "./convex-transport";
import type { WireArgs } from "./convex-transport";
import { autoplayCountdown, PROGRESS_INTERVAL_MS, reportProgress } from "./playback";
import type { Playback } from "./playback";
import { clientLayer } from "./testing/client-context";
import { makeFakePlayer } from "./testing/fake-player";

const started = Schema.decodeSync(StartedPlayback)({
  sessionId: "session-1",
  titleId: "title-1",
  episodeId: null,
  episode: null,
  file: {
    id: "file-1",
    titleId: "title-1",
    episodeId: null,
    versionName: null,
    sizeBytes: 1_000,
    probe: {
      container: "mp4",
      durationMs: 600_000,
      bitRate: null,
      video: [],
      audio: [],
      subtitles: [],
    },
    externalSubtitles: [],
    hdr: false,
    missing: false,
  },
  token: "v1.payload.signature",
  tokenExpiresAt: 1_760_000_000_000,
  mediaBaseUrl: "http://127.0.0.1:9",
  resumePositionMs: 0,
});

const playback: Playback = {
  started,
  stream: {
    mode: "direct",
    url: "http://127.0.0.1:9/media",
    startSeconds: 0,
    durationSeconds: 600,
    video: { codec: "h264", width: 1920, height: 1080, dynamicRange: "sdr" },
    subtitles: [],
    expiresAt: 1_760_000_000_000,
  },
};

/** A transport that records progress calls and acknowledges them. */
const recordingTransport = (calls: Ref.Ref<ReadonlyArray<readonly [FunctionPath, WireArgs]>>) =>
  ConvexTransport.ConvexTransport.of({
    call: (_kind, path, args) =>
      Effect.as(
        Ref.update(calls, (list) => [...list, [path, args] as const]),
        path === "playback:reportProgress" ? { applied: true, watched: false } : { ok: true },
      ),
    subscribe: () => Stream.never,
    setAuth: () => Effect.void,
  });

const advance = (ms: number) =>
  Effect.gen(function* () {
    for (let elapsed = 0; elapsed < ms; elapsed += 100) yield* TestClock.adjust(100);
  });

const onTestClock = <A, E>(body: Effect.Effect<A, E, Scope.Scope>): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(Layer.build(TestClock.layer()), (context) =>
        body.pipe(Effect.provideContext(context)),
      ),
    ),
  );

describe("progress reporting", () => {
  it("reports every ten seconds while playing, on each event, and ends on close", () =>
    onTestClock(
      Effect.gen(function* () {
        const calls = yield* Ref.make<ReadonlyArray<readonly [FunctionPath, WireArgs]>>([]);
        const client = yield* Layer.build(clientLayer(recordingTransport(calls)));
        const player = yield* makeFakePlayer(30_000);
        const scope = yield* Scope.make();

        yield* reportProgress(playback, player).pipe(
          Scope.provide(scope),
          Effect.provideContext(client),
        );

        player.userPlay();
        yield* advance(2 * PROGRESS_INTERVAL_MS + 500);
        player.userPause();
        yield* advance(3 * PROGRESS_INTERVAL_MS);
        player.userSeek(120_000);
        yield* advance(100);
        yield* Scope.close(scope, Exit.void);

        const reported = (yield* Ref.get(calls)).map(([path, args]) =>
          path === "playback:reportProgress" ? args["event"] : path,
        );

        expect(reported).toStrictEqual([
          "resume",
          "tick",
          "tick",
          "pause",
          "seek",
          "playback:endSession",
        ]);

        expect((yield* Ref.get(calls)).at(-1)?.[1]).toStrictEqual({
          sessionId: "session-1",
          positionMs: 120_000,
        });
      }),
    ));
});

describe("autoplay countdown", () => {
  it("counts down each second to zero", () =>
    onTestClock(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(Stream.runCollect(autoplayCountdown(5_000, 1_000)));

        yield* advance(6_000);

        expect(yield* Fiber.await(fiber)).toStrictEqual(
          Exit.succeed([5_000, 4_000, 3_000, 2_000, 1_000, 0]),
        );
      }),
    ));
});
