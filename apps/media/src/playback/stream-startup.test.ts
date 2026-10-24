import { assert, describe, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import { type ClientCapabilities, NegotiateResponse } from "@movies/contracts/media-playback";

import { writeFakeFfmpeg } from "../testing/fake-ffmpeg.ts";
import { ffmpegAvailable } from "../testing/fixture-library.ts";
import * as FixtureWorkspace from "../testing/fixture-workspace.ts";
import * as MediaTestServer from "../testing/media-test-server.ts";
import { signTestToken } from "../testing/test-config.ts";

const hasFfmpeg = await ffmpegAvailable();

const stallsAfterFirstFragment = await writeFakeFfmpeg({ hlsStallsAfterFirstFragment: true });

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

describe.skipIf(!hasFfmpeg)("stream startup", () => {
  layer(MediaTestServer.layer({ FFMPEG_PATH: stallsAfterFirstFragment }), {
    excludeTestServices: true,
    timeout: "60 seconds",
  })((it) => {
    it.effect(
      "serves the init and first segments once the first fragment is written, before the encoder writes the next",
      () =>
        Effect.gen(function* () {
          const server = yield* MediaTestServer.Service;
          const { library } = yield* FixtureWorkspace.Service;
          const token = signTestToken({ fid: server.fileId("movies", library.directMovie) });

          const negotiated = yield* HttpClient.execute(
            HttpClientRequest.post(`${server.baseUrl}/api/playback/negotiate`).pipe(
              HttpClientRequest.bodyJsonUnsafe({ token, capabilities: smallScreen }),
            ),
          ).pipe(
            Effect.flatMap((response) => response.json),
            Effect.flatMap(decodeNegotiation),
            Effect.orDie,
          );

          assert.strictEqual(negotiated.mode, "transcode-software");
          const url = new URL(negotiated.url);

          const file = (name: string) =>
            `${server.baseUrl}${url.pathname.replace(/index\.m3u8$/u, name)}${url.search}`;

          const [init, first] = yield* Effect.all(
            [HttpClient.get(file("init.mp4")), HttpClient.get(file("0.m4s"))],
            { concurrency: "unbounded" },
          ).pipe(Effect.timeout("10 seconds"), Effect.orDie);

          assert.strictEqual(init.status, 200, "init segment");
          assert.strictEqual(first.status, 200, "first segment");
          assert.isAbove((yield* first.arrayBuffer.pipe(Effect.orDie)).byteLength, 0);
        }),
      60_000,
    );
  });
});
