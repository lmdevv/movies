import { join } from "node:path";

import { assert, describe, layer } from "@effect/vitest";
import { Duration, Effect, FileSystem, Result, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import { type ClientCapabilities, NegotiateResponse } from "@movies/contracts/media-playback";

import { writeFakeFfmpeg } from "../testing/fake-ffmpeg.ts";
import { ffmpegAvailable } from "../testing/fixture-library.ts";
import * as FixtureWorkspace from "../testing/fixture-workspace.ts";
import * as MediaTestServer from "../testing/media-test-server.ts";
import { signTestToken } from "../testing/test-config.ts";
import * as PlaybackReporter from "./playback-reporter.ts";

const hasFfmpeg = await ffmpegAvailable();

/** Quick Sync runs write six seconds (segments 0 and 1 of the 12-second clip), then fail. */
const failingQsv = await writeFakeFfmpeg({
  qsvFailsAfterSeconds: 6,
});

/** Every HLS run takes three seconds to start. */
const slowStart = await writeFakeFfmpeg({ hlsDelayMs: 3000 });

/** A small screen forces a transcode of the H.264 fixture. */
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

const negotiateRequest = (baseUrl: string, token: string) =>
  HttpClient.execute(
    HttpClientRequest.post(`${baseUrl}/api/playback/negotiate`).pipe(
      HttpClientRequest.bodyJsonUnsafe({ token, capabilities: smallScreen }),
    ),
  );

/** The path and query of a URL the service built with its public base URL. */
const local = (baseUrl: string, url: string): string => {
  const parsed = new URL(url);

  return `${baseUrl}${parsed.pathname}${parsed.search}`;
};

/** Folders under `TRANSCODE_DIR`, one per open stream. */
const streamFolders = Effect.fn(function* () {
  const server = yield* MediaTestServer.Service;
  const fs = yield* FileSystem.FileSystem;

  return yield* fs.readDirectory(server.transcodeDir).pipe(Effect.orElseSucceed(() => []));
});

/** Waits until no stream is open; fails the test after `within`. */
const awaitNoStreams = (within: Duration.Input) =>
  Effect.gen(function* () {
    for (;;) {
      if ((yield* streamFolders()).length === 0) return;
      yield* Effect.sleep(Duration.millis(50));
    }
  }).pipe(Effect.timeout(within), Effect.orDie);

describe.skipIf(!hasFfmpeg)("stream failures", () => {
  layer(MediaTestServer.layer({ FFMPEG_PATH: failingQsv, HARDWARE_ACCELERATION: "qsv" }), {
    excludeTestServices: true,
    timeout: "120 seconds",
  })((it) => {
    it.effect(
      "restarts a failed Quick Sync run once when several requests wait on it",
      () =>
        Effect.gen(function* () {
          const server = yield* MediaTestServer.Service;
          const { library } = yield* FixtureWorkspace.Service;
          const recording = yield* PlaybackReporter.Recording;

          const token = signTestToken({
            fid: server.fileId("movies", library.directMovie),
            sid: "qsv",
          });

          const response = yield* negotiateRequest(server.baseUrl, token).pipe(Effect.orDie);

          const body = yield* response.json.pipe(Effect.orDie);

          assert.strictEqual(response.status, 200, JSON.stringify(body));
          const negotiated = yield* decodeNegotiation(body).pipe(Effect.orDie);

          assert.strictEqual(negotiated.mode, "transcode-qsv");
          assert.strictEqual(negotiated.generation, 1);
          const playlist = new URL(local(server.baseUrl, negotiated.url));

          // Segment 2 lies past what the run wrote before it died; both requests wait on that run.
          const answers = yield* Effect.forEach(
            [2, 2, 2],
            (index) =>
              HttpClient.get(new URL(`${index}.m4s${playlist.search}`, playlist).toString()).pipe(
                Effect.flatMap((segment) =>
                  segment.json.pipe(Effect.map((error) => ({ status: segment.status, error }))),
                ),
                Effect.orDie,
              ),
            { concurrency: "unbounded" },
          );

          for (const answer of answers) {
            assert.strictEqual(answer.status, 410, JSON.stringify(answer.error));
            assert.deepInclude(answer.error, {
              _tag: "StreamGenerationGone",
              generation: 1,
              currentGeneration: 2,
            });
          }

          const changes = (yield* recording.events).filter(
            PlaybackReporter.PlaybackEvent.guards.ModeChanged,
          );

          assert.strictEqual(changes.length, 1);
          assert.deepInclude(changes[0], { from: "transcode-qsv", to: "transcode-software" });

          const fs = yield* FileSystem.FileSystem;
          const folder = join(server.transcodeDir, negotiated.streamId ?? "");

          assert.deepStrictEqual(yield* fs.readDirectory(folder), ["2"]);
        }),
      30_000,
    );
  });

  layer(
    MediaTestServer.layer({
      FFMPEG_PATH: slowStart,
      MAX_CONCURRENT_TRANSCODES: "1",
      STREAM_IDLE_SECONDS: "600",
    }),
    { excludeTestServices: true, timeout: "120 seconds" },
  )((it) => {
    it.effect(
      "stops the stream and frees its slot when the caller leaves before it starts",
      () =>
        Effect.gen(function* () {
          const server = yield* MediaTestServer.Service;
          const { library } = yield* FixtureWorkspace.Service;
          const recording = yield* PlaybackReporter.Recording;
          const fileId = server.fileId("movies", library.directMovie);

          const abandoned = yield* negotiateRequest(
            server.baseUrl,
            signTestToken({ fid: fileId, sid: "abandoned" }),
          ).pipe(Effect.timeout(Duration.millis(800)), Effect.result);

          assert.isTrue(Result.isFailure(abandoned));

          // Well before the encoder would have started, and far before the idle sweep.
          yield* awaitNoStreams(Duration.seconds(2));

          const ended = (yield* recording.events).filter(
            PlaybackReporter.PlaybackEvent.guards.StreamEnded,
          );

          assert.deepStrictEqual(
            ended.map((event) => event.reason),
            ["abandoned"],
          );

          // The only transcode slot came back: the next viewer starts.
          const next = yield* negotiateRequest(
            server.baseUrl,
            signTestToken({ fid: fileId, sid: "next" }),
          ).pipe(Effect.orDie);

          assert.strictEqual(next.status, 200);
        }),
      30_000,
    );

    it.effect(
      "answers a negotiation replaced while it waits, and leaves no folder behind",
      () =>
        Effect.gen(function* () {
          const server = yield* MediaTestServer.Service;
          const { library } = yield* FixtureWorkspace.Service;
          const fileId = server.fileId("movies", library.remuxMovie);
          const token = signTestToken({ fid: fileId, sid: "replaced" });

          const remux: ClientCapabilities = {
            containers: [],
            videoCodecs: [{ codec: "h264" }],
            audioCodecs: [{ codec: "aac" }, { codec: "ac3", maxChannels: 6 }],
            maxWidth: 1920,
            maxHeight: 1080,
            hls: false,
            mse: true,
          };

          const before = yield* streamFolders();

          const request = HttpClient.execute(
            HttpClientRequest.post(`${server.baseUrl}/api/playback/negotiate`).pipe(
              HttpClientRequest.bodyJsonUnsafe({ token, capabilities: remux }),
            ),
          ).pipe(Effect.orDie);

          const [first, second] = yield* Effect.all(
            [request, request.pipe(Effect.delay(Duration.millis(500)))],
            { concurrency: "unbounded" },
          );

          assert.strictEqual(first.status, 404);
          assert.deepInclude(yield* first.json.pipe(Effect.orDie), { _tag: "StreamNotFound" });
          assert.strictEqual(second.status, 200);

          const negotiated = yield* decodeNegotiation(yield* second.json.pipe(Effect.orDie)).pipe(
            Effect.orDie,
          );

          assert.sameMembers(yield* streamFolders(), [...before, negotiated.streamId ?? ""]);
        }),
      30_000,
    );
  });

  layer(MediaTestServer.layer(), { excludeTestServices: true, timeout: "120 seconds" })((it) => {
    it.effect(
      "never cuts a segment short when a seek deletes its generation",
      () =>
        Effect.gen(function* () {
          const server = yield* MediaTestServer.Service;
          const { library } = yield* FixtureWorkspace.Service;

          const token = signTestToken({
            fid: server.fileId("movies", library.remuxMovie),
            sid: "race",
          });

          const remux: ClientCapabilities = {
            containers: [],
            videoCodecs: [{ codec: "h264" }],
            audioCodecs: [{ codec: "aac" }, { codec: "ac3", maxChannels: 6 }],
            maxWidth: 1920,
            maxHeight: 1080,
            hls: false,
            mse: true,
          };

          for (let round = 0; round < 8; round += 1) {
            // Start at the last segment, so a seek to the beginning replaces the generation.
            const started = yield* HttpClient.execute(
              HttpClientRequest.post(`${server.baseUrl}/api/playback/negotiate`).pipe(
                HttpClientRequest.bodyJsonUnsafe({ token, capabilities: remux, startSeconds: 9 }),
              ),
            ).pipe(
              Effect.flatMap((response) => response.json),
              Effect.flatMap(decodeNegotiation),
              Effect.orDie,
            );

            const playlist = new URL(local(server.baseUrl, started.url));

            const [segment] = yield* Effect.all(
              [
                HttpClient.get(new URL(`2.m4s${playlist.search}`, playlist).toString()).pipe(
                  Effect.flatMap((response) =>
                    response.arrayBuffer.pipe(
                      Effect.map((body) => ({
                        status: response.status,
                        length: body.byteLength,
                        declared: Number(response.headers["content-length"]),
                      })),
                    ),
                  ),
                  Effect.orDie,
                ),
                HttpClient.execute(
                  HttpClientRequest.post(`${server.baseUrl}/api/playback/seek`).pipe(
                    HttpClientRequest.bodyJsonUnsafe({
                      token,
                      streamId: started.streamId,
                      positionSeconds: 0,
                    }),
                  ),
                ).pipe(Effect.orDie),
              ],
              { concurrency: "unbounded" },
            );

            if (segment.status === 200) {
              assert.isAbove(segment.length, 0);
              assert.strictEqual(segment.length, segment.declared);
            } else {
              assert.include([410, 503], segment.status);
            }
          }
        }),
      30_000,
    );
  });

  layer(MediaTestServer.layer({ MIN_FREE_TRANSCODE_MB: "1000000000" }), {
    excludeTestServices: true,
    timeout: "120 seconds",
  })((it) => {
    it.effect(
      "refuses a stream while the transcode folder is too full, and keeps no slot",
      () =>
        Effect.gen(function* () {
          const server = yield* MediaTestServer.Service;
          const { library } = yield* FixtureWorkspace.Service;
          const fileId = server.fileId("movies", library.directMovie);

          for (const sid of ["full-1", "full-2", "full-3", "full-4"]) {
            const response = yield* negotiateRequest(
              server.baseUrl,
              signTestToken({ fid: fileId, sid }),
            ).pipe(Effect.orDie);

            // Refused for space every time, never for capacity: a refusal frees its slot.
            assert.strictEqual(response.status, 507);
            assert.deepInclude(yield* response.json.pipe(Effect.orDie), {
              _tag: "InsufficientTranscodeSpace",
              requiredBytes: 1_000_000_000 * 1024 * 1024,
            });
          }

          assert.deepStrictEqual(yield* streamFolders(), []);
        }),
      30_000,
    );
  });
});
