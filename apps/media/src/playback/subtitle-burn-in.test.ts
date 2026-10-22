import { join } from "node:path";

import { assert, describe, layer } from "@effect/vitest";
import { Duration, Effect, FileSystem, Path, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import { LibraryId } from "@movies/contracts/ids";
import {
  type ClientCapabilities,
  NegotiateResponse,
  SeekResponse,
} from "@movies/contracts/media-playback";

import * as LibraryScanner from "../library/library-scanner.ts";
import * as MemoryLibrary from "../library/memory-library.ts";
import * as MediaTools from "../media/media-tools.ts";
import { ffmpegAvailable } from "../testing/fixture-library.ts";
import * as FixtureWorkspace from "../testing/fixture-workspace.ts";
import * as MediaTestServer from "../testing/media-test-server.ts";
import { signTestToken } from "../testing/test-config.ts";

const hasFfmpeg = await ffmpegAvailable();

const VOBSUB = join(import.meta.dirname, "..", "testing", "fixtures", "vobsub.mkv");

const LIBRARY = LibraryId.make("picture-subtitles");

const FILM = "Picture Subtitles (2020)/Picture Subtitles (2020).mkv";

const chromium: ClientCapabilities = {
  containers: ["mp4"],
  videoCodecs: [{ codec: "h264", maxBitDepth: 8 }],
  audioCodecs: [{ codec: "aac" }],
  maxWidth: 1920,
  maxHeight: 1080,
  hls: false,
  mse: true,
};

const decodeNegotiation = Schema.decodeUnknownEffect(Schema.toCodecJson(NegotiateResponse));

const addFilm = Effect.gen(function* () {
  const workspace = yield* FixtureWorkspace.Service;
  const tools = yield* MediaTools.Service;
  const scanner = yield* LibraryScanner.Service;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.join(workspace.root, "picture-subtitles");
  const output = path.join(root, FILM);

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
    "color=c=0x305070:s=640x360:r=25:d=8",
    "-i",
    VOBSUB,
    "-map",
    "0:v",
    "-map",
    "1:s",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-g",
    "25",
    "-c:s",
    "copy",
    output,
  ]);
  yield* scanner.scan({ libraryId: LIBRARY, root, mode: "incremental" });

  return MemoryLibrary.fileIdOf(LIBRARY, FILM);
});

const negotiate = Effect.fn(function* (
  token: string,
  burnInSubtitle?: string,
  startSeconds?: number,
) {
  const server = yield* MediaTestServer.Service;

  return yield* HttpClient.execute(
    HttpClientRequest.post(`${server.baseUrl}/api/playback/negotiate`).pipe(
      HttpClientRequest.bodyJsonUnsafe({
        token,
        capabilities: chromium,
        burnInSubtitle,
        startSeconds,
      }),
    ),
  ).pipe(
    Effect.flatMap((response) => response.json),
    Effect.flatMap(decodeNegotiation),
    Effect.orDie,
  );
});

const bottomOfSegment = Effect.fn(function* (playlistUrl: string, index: number) {
  const server = yield* MediaTestServer.Service;
  const tools = yield* MediaTools.Service;
  const fs = yield* FileSystem.FileSystem;
  const url = new URL(playlistUrl);
  const base = `${server.baseUrl}${url.pathname}`;

  const fetch = (name: string) =>
    HttpClient.get(new URL(`${name}${url.search}`, base).toString()).pipe(
      Effect.flatMap((response) => response.arrayBuffer),
      Effect.map((buffer) => new Uint8Array(buffer)),
      Effect.orDie,
    );

  const init = yield* fetch("init.mp4");
  const segment = yield* fetch(`${String(index)}.m4s`);
  const file = yield* fs.makeTempFileScoped({ suffix: ".mp4" });

  yield* fs.writeFile(file, new Uint8Array([...init, ...segment]));

  const frame = yield* fs.makeTempFileScoped({ suffix: ".gray" });

  yield* tools.ffmpeg([
    "-hide_banner",
    "-nostdin",
    "-v",
    "error",
    "-y",
    "-i",
    file,
    "-frames:v",
    "1",
    "-vf",
    "crop=iw:ih/3:0:ih*2/3,format=gray",
    "-f",
    "rawvideo",
    frame,
  ]);

  return yield* fs.readFile(frame);
});

const brightSamples = (samples: Uint8Array): number =>
  samples.filter((sample) => sample > 200).length;

describe.skipIf(!hasFfmpeg)("image subtitles", () => {
  layer(MediaTestServer.layer(), { excludeTestServices: true, timeout: "120 seconds" })((it) => {
    it.effect(
      "lists a DVD subtitle, burns it into a transcode on request, and goes back without it",
      () =>
        Effect.gen(function* () {
          const fileId = yield* addFilm.pipe(Effect.orDie);
          const token = signTestToken({ fid: fileId, sid: "burn-in" });

          const plain = yield* negotiate(token);
          const track = plain.subtitles.find((subtitle) => subtitle.kind === "bitmap");

          assert.strictEqual(plain.mode, "remux");
          assert.deepInclude(track, { codec: "dvd_subtitle", source: "embedded" });
          assert.isUndefined(track?.url);
          assert.isUndefined(plain.burnedInSubtitle);

          const burned = yield* negotiate(token, track?.id);

          assert.strictEqual(burned.mode, "transcode-software");
          assert.strictEqual(burned.burnedInSubtitle, track?.id);
          assert.deepStrictEqual([burned.video.width, burned.video.height], [640, 360]);

          const withText = yield* bottomOfSegment(burned.url, 2);

          assert.isAbove(brightSamples(withText), 200);

          const server = yield* MediaTestServer.Service;
          const late = yield* negotiate(token, track?.id, 7);

          const moved = yield* HttpClient.execute(
            HttpClientRequest.post(`${server.baseUrl}/api/playback/seek`).pipe(
              HttpClientRequest.bodyJsonUnsafe({
                token,
                streamId: late.streamId,
                positionSeconds: 5,
              }),
            ),
          ).pipe(
            Effect.flatMap((response) => response.json),
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.toCodecJson(SeekResponse))),
            Effect.orDie,
          );

          assert.strictEqual(moved.generation, 2);

          const afterSeek = yield* bottomOfSegment(moved.playlistUrl, 2);

          assert.isAbove(brightSamples(afterSeek), 200);

          const back = yield* negotiate(token);

          assert.strictEqual(back.mode, "remux");
          assert.isUndefined(back.burnedInSubtitle);
        }),
      60_000,
    );

    it.effect("refuses to burn in a track that is not a picture subtitle", () =>
      Effect.gen(function* () {
        const server = yield* MediaTestServer.Service;
        const { library } = yield* FixtureWorkspace.Service;
        const token = signTestToken({ fid: server.fileId("movies", library.remuxMovie) });

        const response = yield* HttpClient.execute(
          HttpClientRequest.post(`${server.baseUrl}/api/playback/negotiate`).pipe(
            HttpClientRequest.bodyJsonUnsafe({
              token,
              capabilities: chromium,
              burnInSubtitle: "e3",
            }),
          ),
        ).pipe(Effect.orDie);

        assert.strictEqual(response.status, 422);
        assert.deepStrictEqual(yield* response.json.pipe(Effect.orDie), {
          _tag: "UnsupportedPlayback",
          reason: "subtitle-not-burnable",
        });
      }).pipe(Effect.timeout(Duration.seconds(20))),
    );
  });
});
