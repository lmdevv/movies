/**
 * How long playback takes to start, per path, against the real media service: negotiation
 * latency and time to the first media segment for direct play, remux (Matroska, with a Cues
 * index; MPEG-TS, which needs a packet scan), and a software transcode, each cold (no keyframe
 * cache) and warm. Not a CI gate and no thresholds: it prints a table to compare before and after
 * a change.
 *
 *   pnpm --filter @movies/media timing
 *
 * Skipped unless `MOVIES_TIMING=1`. Generates two minutes of 1080p video per file first.
 */
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

const enabled = process.env["MOVIES_TIMING"] === "1" && (await ffmpegAvailable());

const TIMING = LibraryId.make("timing");

const SECONDS = 120;

/** Chromium on a 1080p screen: plays H.264/AAC MP4 directly, AC-3 only through HLS. */
const browser: ClientCapabilities = {
  containers: ["mp4", "webm"],
  videoCodecs: [{ codec: "h264", maxBitDepth: 8 }],
  audioCodecs: [{ codec: "aac" }, { codec: "ac3", maxChannels: 6 }],
  maxWidth: 1920,
  maxHeight: 1080,
  hls: false,
  mse: true,
};

/** The same browser on a 720p screen, so 1080p sources transcode. */
const small: ClientCapabilities = {
  containers: browser.containers,
  videoCodecs: browser.videoCodecs,
  audioCodecs: browser.audioCodecs,
  maxWidth: 1280,
  maxHeight: 720,
  hls: false,
  mse: true,
};

/** One file per path, encoded like a typical release: 1080p H.264, a keyframe every 2 seconds. */
const FILES = {
  direct: { name: "Direct (2020)/Direct (2020).mp4", audio: ["-c:a", "aac"] },
  remuxMkv: { name: "Remux (2020)/Remux (2020).mkv", audio: ["-c:a", "ac3"] },
  remuxTs: { name: "Scan (2020)/Scan (2020).ts", audio: ["-c:a", "ac3"] },
} as const;

const decodeNegotiation = Schema.decodeUnknownEffect(Schema.toCodecJson(NegotiateResponse));

const makeLibrary = Effect.gen(function* () {
  const workspace = yield* FixtureWorkspace.Service;
  const tools = yield* MediaTools.Service;
  const scanner = yield* LibraryScanner.Service;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.join(workspace.root, "timing");

  for (const file of Object.values(FILES)) {
    const output = path.join(root, file.name);

    yield* fs.makeDirectory(path.dirname(output), { recursive: true });
    yield* tools.ffmpeg(
      [
        "-hide_banner",
        "-nostdin",
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        `testsrc2=size=1920x1080:rate=24:duration=${String(SECONDS)}`,
        "-f",
        "lavfi",
        "-i",
        `sine=frequency=440:sample_rate=48000:duration=${String(SECONDS)}`,
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-b:v",
        "8M",
        "-pix_fmt",
        "yuv420p",
        "-g",
        "48",
        ...file.audio,
        output,
      ],
      { timeout: Duration.minutes(10) },
    );
  }

  yield* scanner.scan({ libraryId: TIMING, root, mode: "incremental" });
});

/** Milliseconds `effect` took, with its result. */
const timed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const started = performance.now();
    const value = yield* effect;

    return { value, ms: Math.round(performance.now() - started) };
  });

/** Negotiates `relativePath` for `capabilities`, then fetches its first media bytes. */
const startPlayback = Effect.fn(function* (
  relativePath: string,
  capabilities: ClientCapabilities,
  session: string,
) {
  const server = yield* MediaTestServer.Service;
  const fileId = MemoryLibrary.fileIdOf(TIMING, relativePath);
  const token = signTestToken({ fid: fileId, sid: session });

  const negotiation = yield* timed(
    HttpClient.execute(
      HttpClientRequest.post(`${server.baseUrl}/api/playback/negotiate`).pipe(
        HttpClientRequest.bodyJsonUnsafe({ token, capabilities }),
      ),
    ).pipe(
      Effect.flatMap((response) => response.json),
      Effect.flatMap(decodeNegotiation),
      Effect.orDie,
    ),
  );

  const url = new URL(negotiation.value.url);
  const local = `${server.baseUrl}${url.pathname}${url.search}`;

  const media =
    negotiation.value.mode === "direct"
      ? HttpClient.get(local, { headers: { range: "bytes=0-1048575" } })
      : HttpClient.get(new URL(`init.mp4${url.search}`, local).toString()).pipe(
          Effect.andThen(HttpClient.get(new URL(`0.m4s${url.search}`, local).toString())),
        );

  const first = yield* timed(
    media.pipe(
      Effect.flatMap((response) => response.arrayBuffer),
      Effect.orDie,
    ),
  );

  // Stop it, so its encoder does not compete with the next measurement.
  if (negotiation.value.streamId !== undefined) {
    yield* HttpClient.execute(
      HttpClientRequest.post(`${server.baseUrl}/api/playback/stop`).pipe(
        HttpClientRequest.bodyJsonUnsafe({ token, streamId: negotiation.value.streamId }),
      ),
    ).pipe(Effect.orDie);
  }

  return {
    mode: negotiation.value.mode,
    negotiateMs: negotiation.ms,
    firstSegmentMs: first.ms,
    totalMs: negotiation.ms + first.ms,
  };
});

describe.skipIf(!enabled)("playback start timing", () => {
  layer(MediaTestServer.layer({ STREAM_IDLE_SECONDS: "600" }), {
    excludeTestServices: true,
    timeout: "600 seconds",
  })((it) => {
    it.effect(
      "measures negotiation and first segment per path, cold and warm",
      () =>
        Effect.gen(function* () {
          yield* makeLibrary;

          const cases = [
            ["direct", FILES.direct.name, browser],
            ["remux (mkv, cues)", FILES.remuxMkv.name, browser],
            ["remux (ts, packet scan)", FILES.remuxTs.name, browser],
            ["software transcode", FILES.direct.name, small],
          ] as const;

          const rows = [];

          for (const [label, file, capabilities] of cases) {
            for (const [run, temperature] of ["cold", "warm", "warm"].entries()) {
              const result = yield* startPlayback(file, capabilities, `${label}-${String(run)}`);

              rows.push({ path: label, run: temperature, ...result });
            }
          }

          console.table(rows);
          assert.isAbove(rows.length, 0);
        }),
      600_000,
    );
  });
});
