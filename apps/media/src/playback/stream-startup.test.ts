import { assert, describe, layer } from "@effect/vitest";
import { Duration, Effect, FileSystem, Layer, Option, Path, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import { type ClientCapabilities, NegotiateResponse } from "@movies/contracts/media-playback";

import * as MediaTools from "../media/media-tools.ts";
import { writeFakeFfmpeg } from "../testing/fake-ffmpeg.ts";
import { ffmpegAvailable } from "../testing/fixture-library.ts";
import * as FixtureWorkspace from "../testing/fixture-workspace.ts";
import * as MediaTestServer from "../testing/media-test-server.ts";
import { signTestToken } from "../testing/test-config.ts";
import { FRAGMENT_HEAD_BYTES, fragmentSpan } from "./fmp4-fragments.ts";
import { AudioPlan, VideoPlan } from "./playback-decision.ts";
import * as PlaybackReporter from "./playback-reporter.ts";
import * as StreamSessions from "./stream-sessions.ts";
import { hlsCommandArgs } from "./transcode-command.ts";

const hasFfmpeg = await ffmpegAvailable();

const stallsAfterFirstFragment = await writeFakeFfmpeg({ hlsStallsAfterFirstFragment: true });

const qsvFailsAfterFirstFragment = await writeFakeFfmpeg({ qsvFailsAfterFirstFragment: true });

const startsLateThenStalls = await writeFakeFfmpeg({
  hlsDelayMs: 1500,
  hlsStallsAfterFirstFragment: true,
});

const LATE_KEYFRAME = 383 / 24;

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

  layer(
    MediaTestServer.layer({
      FFMPEG_PATH: qsvFailsAfterFirstFragment,
      HARDWARE_ACCELERATION: "qsv",
    }),
    { excludeTestServices: true, timeout: "60 seconds" },
  )((it) => {
    it.effect(
      "falls back to software before serving when Quick Sync fails after its first fragment",
      () =>
        Effect.gen(function* () {
          const server = yield* MediaTestServer.Service;
          const { library } = yield* FixtureWorkspace.Service;
          const recording = yield* PlaybackReporter.Recording;
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

          const changes = (yield* recording.events).filter(
            PlaybackReporter.PlaybackEvent.guards.ModeChanged,
          );

          assert.deepStrictEqual(
            changes.map((change) => [change.from, change.to, change.reason]),
            [["transcode-qsv", "transcode-software", "hardware-unavailable"]],
          );
        }),
      60_000,
    );
  });

  layer(
    MediaTestServer.layer({ FFMPEG_PATH: startsLateThenStalls }).pipe(
      Layer.provide(Layer.succeed(StreamSessions.PollInterval, Duration.minutes(5))),
    ),
    { excludeTestServices: true, timeout: "60 seconds" },
  )((it) => {
    it.effect(
      "answers a waiting segment request when its fragment is written, not on the next poll",
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

          const url = new URL(negotiated.url);

          const first = yield* HttpClient.get(
            `${server.baseUrl}${url.pathname.replace(/index\.m3u8$/u, "0.m4s")}${url.search}`,
          ).pipe(Effect.timeout("20 seconds"), Effect.orDie);

          assert.strictEqual(first.status, 200, "first segment");
        }),
      60_000,
    );
  });

  layer(MediaTestServer.layer(), { excludeTestServices: true, timeout: "60 seconds" })((it) => {
    it.effect(
      "starts each copied fragment where the previous one ends, even when the last frame's duration overshoots",
      () =>
        Effect.gen(function* () {
          const workspace = yield* FixtureWorkspace.Service;
          const tools = yield* MediaTools.Service;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = path.join(workspace.root, "vfr");
          const output = path.join(root, "hls");
          const steady = path.join(root, "steady.mkv");
          const variable = path.join(root, "variable.mkv");

          yield* fs.makeDirectory(output, { recursive: true });
          yield* tools.ffmpeg([
            "-hide_banner",
            "-nostdin",
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=320x180:rate=24:duration=24",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-bf",
            "0",
            "-g",
            "1000",
            "-sc_threshold",
            "0",
            "-pix_fmt",
            "yuv420p",
            "-force_key_frames",
            `0,4,8,12,${String(LATE_KEYFRAME)},16,20`,
            steady,
          ]);
          // The frame before the keyframe at 383/24 s moves to 3 ms before it, so it keeps its
          // 41 ms duration and the fragment it ends seems to run 38 ms past that keyframe.
          yield* tools.ffmpeg([
            "-hide_banner",
            "-nostdin",
            "-v",
            "error",
            "-y",
            "-i",
            steady,
            "-c",
            "copy",
            "-bsf:v",
            `setts=ts='if(eq(N\\,382)\\,round(${String(LATE_KEYFRAME - 0.003)}/TB)\\,TS)'`,
            variable,
          ]);
          yield* tools.ffmpeg(
            hlsCommandArgs({
              input: variable,
              sourceStart: 0,
              from: 0,
              videoIndex: 0,
              videoCodec: "h264",
              videoBitDepth: 8,
              video: VideoPlan.Copy(),
              audio: AudioPlan.None(),
              audioCodec: "",
              copiedAudioEnd: undefined,
              subtitleCodec: "",
              segmentStarts: [0, 4, 8, 12, 16, 20],
              previousStart: undefined,
              outputDirectory: output,
              qsvDevice: "",
              vaapiDevice: "",
            }),
          );

          const names = (yield* fs.readDirectory(output))
            .flatMap((name) => /^f(\d+)\.m4s$/u.exec(name)?.[1] ?? [])
            .map(Number)
            .toSorted((left, right) => left - right);

          const spans = yield* Effect.forEach(names, (number) =>
            fs
              .readFile(path.join(output, `f${String(number)}.m4s`))
              .pipe(Effect.map((bytes) => fragmentSpan(bytes.subarray(0, FRAGMENT_HEAD_BYTES)))),
          );

          const ends = spans.map((span) => Option.fromNullishOr(span?.end));

          assert.isTrue(
            spans.some(
              (span) =>
                span !== undefined && span.start < 12.1 && (span.end ?? 0) > LATE_KEYFRAME + 0.03,
            ),
            "the fragment before the late keyframe claims to run past it",
          );

          for (const [index, span] of spans.entries()) {
            if (index === 0) continue;
            assert.deepStrictEqual(
              Option.some(span?.start),
              ends[index - 1],
              `f${String(index)} starts where f${String(index - 1)} ends`,
            );
          }
        }),
      60_000,
    );
  });
});
