import { assert, describe, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import { type ClientCapabilities, NegotiateResponse } from "@movies/contracts/media-playback";

import { ffmpegAvailable } from "../testing/fixture-library.ts";
import * as FixtureWorkspace from "../testing/fixture-workspace.ts";
import * as MediaTestServer from "../testing/media-test-server.ts";
import { signTestToken } from "../testing/test-config.ts";

const hasFfmpeg = await ffmpegAvailable();

const smallScreen: ClientCapabilities = {
  containers: [],
  videoCodecs: [{ codec: "h264", maxBitDepth: 8 }],
  audioCodecs: [{ codec: "aac" }],
  maxWidth: 1920,
  maxHeight: 120,
  hls: false,
  mse: true,
};

const decodeNegotiation = Schema.decodeUnknownEffect(Schema.toCodecJson(NegotiateResponse));

const negotiate = Effect.fn(function* (sid: string) {
  const server = yield* MediaTestServer.Service;
  const { library } = yield* FixtureWorkspace.Service;

  const response = yield* HttpClient.execute(
    HttpClientRequest.post(`${server.baseUrl}/api/playback/negotiate`).pipe(
      HttpClientRequest.bodyJsonUnsafe({
        token: signTestToken({ fid: server.fileId("movies", library.directMovie), sid }),
        capabilities: smallScreen,
      }),
    ),
  ).pipe(Effect.orDie);

  const negotiated = yield* response.json.pipe(Effect.flatMap(decodeNegotiation), Effect.orDie);
  const playlist = new URL(negotiated.url.replace(/^https?:\/\/[^/]+/u, server.baseUrl));

  return {
    streamId: negotiated.streamId ?? "",
    file: (name: string) => new URL(`${name}${playlist.search}`, playlist).toString(),
  };
});

const status = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.map((response) => response.status),
    Effect.orDie,
  );

describe.skipIf(!hasFfmpeg)("stream liveness", () => {
  layer(MediaTestServer.layer({ STREAM_IDLE_SECONDS: "1" }), {
    excludeTestServices: true,
    timeout: "120 seconds",
  })("with a one second idle timeout", (it) => {
    it.effect.fails(
      "keeps serving a stream's URL after its player goes quiet past the idle timeout",
      () =>
        Effect.gen(function* () {
          const stream = yield* negotiate("quiet");

          assert.strictEqual(yield* status(stream.file("init.mp4")), 200);
          assert.strictEqual(yield* status(stream.file("0.m4s")), 200);
          assert.strictEqual(yield* status(stream.file("1.m4s")), 200);

          yield* Effect.sleep("2500 millis");

          assert.strictEqual(
            yield* status(stream.file("2.m4s")),
            200,
            `segment 2 of ${stream.streamId} after the player went quiet`,
          );
        }),
      60_000,
    );
  });
});
