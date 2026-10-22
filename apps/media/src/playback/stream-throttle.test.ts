import { assert, describe, layer } from "@effect/vitest";
import { Duration, Effect, FileSystem, Path, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import { LibraryId } from "@movies/contracts/ids";
import { type ClientCapabilities, NegotiateResponse } from "@movies/contracts/media-playback";

import * as LibraryScanner from "../library/library-scanner.ts";
import * as MemoryLibrary from "../library/memory-library.ts";
import * as MediaTools from "../media/media-tools.ts";
import { ffmpegAvailable } from "../testing/fixture-library.ts";
import * as FixtureWorkspace from "../testing/fixture-workspace.ts";
import * as MediaTestServer from "../testing/media-test-server.ts";
import { signTestToken } from "../testing/test-config.ts";

const hasFfmpeg = await ffmpegAvailable();

const LONG = LibraryId.make("long");

const LONG_FILE = "Long Fixture (2020)/Long Fixture (2020).mkv";

const LONG_SECONDS = 600;

const smallScreen: ClientCapabilities = {
  containers: [],
  videoCodecs: [{ codec: "h264", maxBitDepth: 8 }],
  audioCodecs: [{ codec: "aac" }],
  maxWidth: 1920,
  maxHeight: 90,
  hls: false,
  mse: true,
};

const decodeNegotiation = Schema.decodeUnknownEffect(Schema.toCodecJson(NegotiateResponse));

const addLongClip = Effect.gen(function* () {
  const workspace = yield* FixtureWorkspace.Service;
  const tools = yield* MediaTools.Service;
  const scanner = yield* LibraryScanner.Service;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.join(workspace.root, "long");
  const output = path.join(root, LONG_FILE);

  yield* fs.makeDirectory(path.dirname(output), { recursive: true });

  yield* tools.ffmpeg([
    "-hide_banner",
    "-nostdin",
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=320x180:rate=24:duration=${String(LONG_SECONDS)}`,
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-g",
    "48",
    output,
  ]);

  yield* scanner.scan({ libraryId: LONG, root, mode: "incremental" });

  return MemoryLibrary.fileIdOf(LONG, LONG_FILE);
});

const writtenFragments = Effect.fn(function* (streamId: string) {
  const server = yield* MediaTestServer.Service;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const names = yield* fs
    .readDirectory(path.join(server.transcodeDir, streamId, "1"))
    .pipe(Effect.orElseSucceed(() => []));

  return names.filter((name) => /^f\d+\.m4s$/.test(name)).length;
});

describe.skipIf(!hasFfmpeg)("stream throttling", () => {
  layer(MediaTestServer.layer({ STREAM_BUFFER_AHEAD_SECONDS: "20" }), {
    excludeTestServices: true,
    timeout: "120 seconds",
  })((it) => {
    it.effect(
      "pauses ffmpeg ahead of the player and continues when the player catches up",
      () =>
        Effect.gen(function* () {
          const server = yield* MediaTestServer.Service;
          const fileId = yield* addLongClip.pipe(Effect.orDie);
          const token = signTestToken({ fid: fileId, sid: "throttle" });

          const response = yield* HttpClient.execute(
            HttpClientRequest.post(`${server.baseUrl}/api/playback/negotiate`).pipe(
              HttpClientRequest.bodyJsonUnsafe({ token, capabilities: smallScreen }),
            ),
          ).pipe(Effect.orDie);

          const negotiated = yield* response.json.pipe(
            Effect.flatMap(decodeNegotiation),
            Effect.orDie,
          );

          assert.strictEqual(negotiated.mode, "transcode-software");
          const streamId = negotiated.streamId ?? "";

          yield* Effect.sleep(Duration.seconds(4));
          const paused = yield* writtenFragments(streamId);
          yield* Effect.sleep(Duration.seconds(2));

          assert.strictEqual(yield* writtenFragments(streamId), paused);
          assert.isBelow(paused, LONG_SECONDS / 4);

          const playlist = new URL(negotiated.url.replace(/^https?:\/\/[^/]+/u, server.baseUrl));
          const index = paused - 2;

          const segment = yield* HttpClient.get(
            new URL(`${String(index)}.m4s${playlist.search}`, playlist).toString(),
          ).pipe(Effect.orDie);

          assert.strictEqual(segment.status, 200);
          yield* Effect.sleep(Duration.seconds(3));
          assert.isAbove(yield* writtenFragments(streamId), paused);
        }),
      60_000,
    );
  });
});
