import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";

import { ClientDiagnosticsRequest, PlayerObservation } from "@movies/contracts/diagnostics";
import { StreamId } from "@movies/contracts/media-playback";
import { StartedPlayback } from "@movies/contracts/models/playback";
import { Effect, Exit, Layer, Option, Predicate, Redacted, Schema, Scope } from "effect";
import { TestClock } from "effect/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Playback } from "./playback";
import type { PlayerEvent, PlayerPort } from "./room-sync/player-port";
import type { FrameCounts } from "./player-diagnostics";
import { reportDiagnostics } from "./player-diagnostics";
import { makeFakePlayer } from "./testing/fake-player";

/** Every batch the media service received, decoded as the service decodes it. */
const batches: Array<ClientDiagnosticsRequest> = [];

const decodeBatch = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.toCodecJson(ClientDiagnosticsRequest)),
);

const server = createServer((request: IncomingMessage, response: ServerResponse) => {
  let body = "";

  request.on("data", (chunk: Buffer) => {
    body += chunk.toString("utf8");
  });

  request.on("end", () => {
    if (request.url === "/api/playback/diagnostics") batches.push(decodeBatch(body));
    response.writeHead(204).end();
  });
});

let base = "";

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  if (address === null || Predicate.isString(address)) throw new Error("The server is not on TCP");

  base = `http://127.0.0.1:${String(address.port)}`;
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  batches.length = 0;
});

/** A playback of an HLS stream served by the test server. */
const playbackAt = (mediaBaseUrl: string, token = "v1.payload.signature"): Playback => ({
  started: Schema.decodeSync(StartedPlayback)({
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
        container: "mkv",
        durationMs: 600_000,
        bitRate: null,
        video: [],
        audio: [],
        subtitles: [],
      },
      externalSubtitles: [],
      hdr: false,
      missing: false,
      trickplay: null,
    },
    token,
    tokenExpiresAt: 1_760_000_000_000,
    mediaBaseUrl,
    resumePositionMs: 0,
  }),
  stream: {
    mode: "remux",
    url: `${mediaBaseUrl}/media/hls/AAAAAAAAAAAAAAAAAAAAAA/1/index.m3u8`,
    streamId: StreamId.make("AAAAAAAAAAAAAAAAAAAAAA"),
    generation: 1,
    startSeconds: 0,
    durationSeconds: 600,
    video: { codec: "h264", width: 1920, height: 1080, dynamicRange: "sdr" },
    subtitles: [],
    expiresAt: 1_760_000_000_000,
  },
});

const onTestClock = <A, E>(body: Effect.Effect<A, E, Scope.Scope>): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(Layer.build(TestClock.layer()), (context) =>
        body.pipe(Effect.provideContext(context)),
      ),
    ),
  );

/** Resolves once `predicate` holds, checking in real time while requests travel. */
const until = (predicate: () => boolean) =>
  Effect.promise(
    () =>
      new Promise<void>((resolve) => {
        const check = (): void => {
          if (predicate()) resolve();
          else setTimeout(check, 5);
        };

        check();
      }),
  );

/** A recovery after `reason`. */
const recovery = (reason: string) =>
  PlayerObservation.cases.Recovery.make({ action: "new-session", reason });

/** Every event received, in order. */
const received = () => batches.flatMap((batch) => batch.events);

describe("playback diagnostics", () => {
  it("reports a stall with its length, and what the platform recorded", () =>
    onTestClock(
      Effect.gen(function* () {
        const player = yield* makeFakePlayer(60_000);
        const scope = yield* Scope.make();
        const playback = playbackAt(base);

        const recorder = yield* reportDiagnostics(player, {
          platform: "web",
          playback: () => Option.some(playback),
          bufferedAheadSeconds: () => 0,
          frames: () => Option.none(),
        }).pipe(Scope.provide(scope));

        recorder.record(PlayerObservation.cases.Attached.make({ mode: "remux", engine: "hls.js" }));
        player.userPlay();
        player.stall();
        yield* TestClock.adjust(31_000);
        player.recover();
        yield* Scope.close(scope, Exit.void);

        expect(received()).toMatchObject([
          { observation: { _tag: "Attached" } },
          { observation: { _tag: "BufferingStarted" } },
          { observation: { _tag: "BufferingEnded" } },
        ]);
        expect(batches.map((batch) => Redacted.value(batch.token))).toContain(
          "v1.payload.signature",
        );
        expect(batches.every((batch) => batch.platform === "web")).toBe(true);
        expect(received().at(-1)).toMatchObject({
          streamId: "AAAAAAAAAAAAAAAAAAAAAA",
          ageMs: 0,
          observation: {
            _tag: "BufferingEnded",
            durationMs: 31_000,
            endedBy: "playing",
            positionSeconds: 60,
          },
        });
      }),
    ));

  it("sends what it recorded within a few seconds, without waiting for the end", () =>
    onTestClock(
      Effect.gen(function* () {
        const player = yield* makeFakePlayer(0);
        const playback = playbackAt(base);

        const recorder = yield* reportDiagnostics(player, {
          platform: "web",
          playback: () => Option.some(playback),
          bufferedAheadSeconds: () => 0,
          frames: () => Option.none(),
        });

        recorder.record(
          PlayerObservation.cases.Attached.make({ mode: "direct", engine: "html-video" }),
        );
        yield* TestClock.adjust(5_000);
        yield* until(() => batches.length > 0);

        expect(received()).toMatchObject([{ ageMs: 5_000, observation: { _tag: "Attached" } }]);
      }),
    ));

  it("samples dropped frames and sends what is left as the scope closes", () =>
    onTestClock(
      Effect.gen(function* () {
        const player = yield* makeFakePlayer(0);
        const scope = yield* Scope.make();
        const playback = playbackAt(base);
        let frames: FrameCounts = { dropped: 2, decoded: 100 };

        const recorder = yield* reportDiagnostics(player, {
          platform: "ios",
          playback: () => Option.some(playback),
          bufferedAheadSeconds: () => 12,
          frames: () => Option.some(frames),
        }).pipe(Scope.provide(scope));

        yield* TestClock.adjust(5_000);
        yield* until(() => batches.length > 0);
        frames = { dropped: 12, decoded: 1_100 };
        recorder.record(
          PlayerObservation.cases.Recovery.make({
            action: "renegotiate",
            reason: "StreamNotFound",
          }),
        );
        yield* Scope.close(scope, Exit.void);

        expect(received()).toMatchObject([
          { observation: { _tag: "DroppedFrames", dropped: 2, decoded: 100 } },
          { observation: { _tag: "Recovery" } },
          { observation: { _tag: "DroppedFrames", dropped: 10, decoded: 1_000 } },
        ]);
      }),
    ));

  it("sends each event with the token of the playback it happened in, or the one before", () =>
    onTestClock(
      Effect.gen(function* () {
        const player = yield* makeFakePlayer(0);
        const scope = yield* Scope.make();
        const first = playbackAt(base, "v1.first.session");
        const second = playbackAt(base, "v1.second.session");
        let playing = Option.some(first);

        const recorder = yield* reportDiagnostics(player, {
          platform: "web",
          playback: () => playing,
          bufferedAheadSeconds: () => 0,
          frames: () => Option.none(),
        }).pipe(Scope.provide(scope));

        recorder.record(recovery("first"));
        playing = Option.none();
        recorder.record(recovery("between"));
        playing = Option.some(second);
        recorder.record(recovery("second"));
        yield* Scope.close(scope, Exit.void);

        expect(
          batches.map((batch) => [
            Redacted.value(batch.token),
            batch.events.map((event) => event.observation),
          ]),
        ).toMatchObject([
          ["v1.first.session", [{ reason: "first" }, { reason: "between" }]],
          ["v1.second.session", [{ reason: "second" }]],
        ]);
      }),
    ));

  it("counts no stall while the viewer is paused, however long", () =>
    onTestClock(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const playback = playbackAt(base);
        const listeners = new Set<(event: PlayerEvent) => void>();
        let paused = true;

        // A paused element that runs out of data, as a scrub outside the buffer leaves it.
        const player: PlayerPort = {
          positionMs: () => 0,
          isPaused: () => paused,
          isBuffering: () => false,
          playbackRate: () => 1,
          setPlaybackRate: () => undefined,
          seek: () => undefined,
          play: () => Promise.resolve(),
          pause: () => undefined,
          subscribe: (listener) => {
            listeners.add(listener);

            return () => listeners.delete(listener);
          },
        };

        const emit = (event: PlayerEvent) => {
          for (const listener of listeners) listener(event);
        };

        yield* reportDiagnostics(player, {
          platform: "web",
          playback: () => Option.some(playback),
          bufferedAheadSeconds: () => 0,
          frames: () => Option.none(),
        }).pipe(Scope.provide(scope));

        emit("waiting");
        emit("seeked");
        yield* TestClock.adjust(600_000);
        paused = false;
        emit("playing");
        yield* Scope.close(scope, Exit.void);

        expect(received()).toStrictEqual([]);
      }),
    ));

  it("ends a stall the viewer gave up on when the player closes", () =>
    onTestClock(
      Effect.gen(function* () {
        const player = yield* makeFakePlayer(0);
        const scope = yield* Scope.make();
        const playback = playbackAt(base);

        yield* reportDiagnostics(player, {
          platform: "web",
          playback: () => Option.some(playback),
          bufferedAheadSeconds: () => 0,
          frames: () => Option.none(),
        }).pipe(Scope.provide(scope));

        player.userPlay();
        player.stall();
        yield* TestClock.adjust(7_000);
        yield* Scope.close(scope, Exit.void);

        expect(received().map((event) => event.observation)).toMatchObject([
          { _tag: "BufferingStarted" },
          { _tag: "BufferingEnded", durationMs: 7_000, endedBy: "closed" },
        ]);
      }),
    ));

  it("splits a burst into batches the service accepts", () =>
    onTestClock(
      Effect.gen(function* () {
        const player = yield* makeFakePlayer(0);
        const scope = yield* Scope.make();
        const playback = playbackAt(base);

        const recorder = yield* reportDiagnostics(player, {
          platform: "web",
          playback: () => Option.some(playback),
          bufferedAheadSeconds: () => 0,
          frames: () => Option.none(),
        }).pipe(Scope.provide(scope));

        for (let index = 0; index < 150; index += 1) {
          recorder.record(
            PlayerObservation.cases.FragmentLoaded.make({
              segment: index,
              durationMs: 50,
              firstByteMs: 10,
              bytes: 1_000,
            }),
          );
        }

        yield* Scope.close(scope, Exit.void);

        expect(batches.map((batch) => batch.events.length)).toStrictEqual([100, 50]);
      }),
    ));
});
