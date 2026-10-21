import { assert, describe, layer } from "@effect/vitest";
import { Effect, FileSystem, Path, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http";

import { artworkUrl } from "@movies/contracts/artwork";
import {
  type ClientCapabilities,
  HealthResponse,
  NegotiateResponse,
  type PlaybackQuality,
} from "@movies/contracts/media-playback";

import * as ArtworkKeys from "../artwork/artwork-keys.ts";
import * as MediaTools from "../media/media-tools.ts";
import { parseFfprobeJson } from "../media/media-probe.ts";
import * as PlaybackReporter from "../playback/playback-reporter.ts";
import {
  ffmpegAvailable,
  qsvUsable,
  softwareToneMappingAvailable,
  vaapiUsable,
} from "../testing/fixture-library.ts";
import * as FixtureWorkspace from "../testing/fixture-workspace.ts";
import * as MediaTestServer from "../testing/media-test-server.ts";
import { signTestToken } from "../testing/test-config.ts";
import { sidecarTrackId } from "../subtitles/subtitle-tracks.ts";

const hasFfmpeg = await ffmpegAvailable();

const hasQsv = hasFfmpeg && (await qsvUsable());

const hasVaapi = hasFfmpeg && (await vaapiUsable());

const canToneMap = hasFfmpeg && (await softwareToneMappingAvailable());

const browser: ClientCapabilities = {
  containers: ["mp4", "webm"],
  videoCodecs: [{ codec: "h264", maxBitDepth: 8 }, { codec: "vp9" }, { codec: "av1" }],
  audioCodecs: [{ codec: "aac" }, { codec: "mp3" }, { codec: "opus" }, { codec: "flac" }],
  maxWidth: 3840,
  maxHeight: 2160,
  hls: false,
  mse: true,
};

const withDolbyAudio: ClientCapabilities = {
  containers: browser.containers,
  videoCodecs: browser.videoCodecs,
  audioCodecs: browser.audioCodecs.concat([
    { codec: "ac3", maxChannels: 6 },
    { codec: "eac3", maxChannels: 8 },
  ]),
  maxWidth: browser.maxWidth,
  maxHeight: browser.maxHeight,
  hls: false,
  mse: true,
};

/** A small screen forces a downscale, so even H.264 sources are transcoded. */
const smallScreen: ClientCapabilities = {
  containers: [],
  videoCodecs: browser.videoCodecs,
  audioCodecs: browser.audioCodecs,
  maxWidth: 1920,
  maxHeight: 120,
  hls: false,
  mse: true,
};

const decodeHealth = Schema.decodeUnknownEffect(HealthResponse);

/** A JSON request body sent to the control API. */
interface RequestBody {
  readonly token: string;
  readonly capabilities?: ClientCapabilities;
  readonly startSeconds?: number;
  readonly audioStreamIndex?: number;
  readonly streamId?: string;
  readonly positionSeconds?: number;
}

/** A diagnostics batch as a player sends it, or a malformed one. */
interface WireBatch {
  readonly token: string;
  readonly platform: string;
  readonly events: ReadonlyArray<{
    readonly ageMs: number;
    readonly observation: Readonly<Record<string, string | number>>;
  }>;
}

/** Decodes a negotiation body the way an HttpApi client does. */
const decodeNegotiation = Schema.decodeUnknownEffect(Schema.toCodecJson(NegotiateResponse));

/** The path and query of a URL the service built with its public base URL. */
const local = (baseUrl: string, url: string): string => {
  const parsed = new URL(url);

  return `${baseUrl}${parsed.pathname}${parsed.search}`;
};

const get = (url: string, headers: Readonly<Record<string, string>> = {}) =>
  HttpClient.get(url, { headers }).pipe(Effect.orDie);

const post = (url: string, body: RequestBody) =>
  HttpClient.execute(HttpClientRequest.post(url).pipe(HttpClientRequest.bodyJsonUnsafe(body))).pipe(
    Effect.orDie,
  );

const bytes = (response: HttpClientResponse.HttpClientResponse) =>
  response.arrayBuffer.pipe(
    Effect.map((buffer) => new Uint8Array(buffer)),
    Effect.orDie,
  );

const json = (response: HttpClientResponse.HttpClientResponse) => response.json.pipe(Effect.orDie);

const negotiate = Effect.fn(function* (body: {
  readonly token: string;
  readonly capabilities: ClientCapabilities;
  readonly startSeconds?: number;
  readonly audioStreamIndex?: number;
  readonly quality?: PlaybackQuality;
}) {
  const server = yield* MediaTestServer.Service;
  const response = yield* post(`${server.baseUrl}/api/playback/negotiate`, body);

  return { status: response.status, body: yield* json(response) };
});

const negotiated = Effect.fn(function* (body: Parameters<typeof negotiate>[0]) {
  const result = yield* negotiate(body);

  assert.strictEqual(result.status, 200, JSON.stringify(result.body));

  return yield* decodeNegotiation(result.body).pipe(Effect.orDie);
});

/** Probes bytes with ffprobe after writing them to a temporary file. */
const probeBytes = Effect.fn(function* (data: Uint8Array) {
  const fs = yield* FileSystem.FileSystem;
  const tools = yield* MediaTools.Service;
  const file = yield* fs.makeTempFileScoped({ suffix: ".mp4" });

  yield* fs.writeFile(file, data);

  const output = yield* tools.ffprobe([
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    file,
  ]);

  return yield* parseFfprobeJson(output, file);
});

/** Width and height of an image, read with ffprobe. */
const probeImage = Effect.fn(function* (data: Uint8Array) {
  const fs = yield* FileSystem.FileSystem;
  const tools = yield* MediaTools.Service;
  const file = yield* fs.makeTempFileScoped({ suffix: ".jpg" });

  yield* fs.writeFile(file, data);

  const output = yield* tools.ffprobe([
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_streams",
    file,
  ]);

  return yield* Schema.decodeEffect(
    Schema.fromJsonString(
      Schema.Struct({
        streams: Schema.Tuple([Schema.Struct({ width: Schema.Int, height: Schema.Int })]),
      }),
    ),
  )(output).pipe(Effect.map((probe) => probe.streams[0]));
});

/** Fetches the init segment and media segment `index` of an HLS playlist URL. */
const fetchSegment = Effect.fn(function* (playlistUrl: string, index: number) {
  const playlist = new URL(playlistUrl);
  const init = yield* get(new URL(`init.mp4${playlist.search}`, playlist).toString());
  const segment = yield* get(new URL(`${index}.m4s${playlist.search}`, playlist).toString());

  return { init, segment };
});

const concat = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;

  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }

  return out;
};

describe.skipIf(!hasFfmpeg)("media service over HTTP", () => {
  layer(MediaTestServer.layer(), { excludeTestServices: true, timeout: "120 seconds" })((it) => {
    it.effect("reports health", () =>
      Effect.gen(function* () {
        const server = yield* MediaTestServer.Service;
        const response = yield* get(`${server.baseUrl}/api/health`);

        assert.deepStrictEqual(yield* json(response), {
          status: "ok",
          activeStreams: 0,
          hardwareAcceleration: "none",
          backend: "standalone",
        });
      }),
    );

    it.effect("has no Convex URL for apps when it runs standalone", () =>
      Effect.gen(function* () {
        const server = yield* MediaTestServer.Service;
        const response = yield* get(`${server.baseUrl}/api/client-config`);

        assert.deepStrictEqual(yield* json(response), {});
      }),
    );

    it.effect("serves artwork by sealed key, resized on request, and refuses others", () =>
      Effect.gen(function* () {
        const server = yield* MediaTestServer.Service;
        const workspace = yield* FixtureWorkspace.Service;
        const keys = yield* ArtworkKeys.Service;
        const path = yield* Path.Path;

        const poster = yield* keys.seal(
          ArtworkKeys.ArtworkSource.Local({
            path: path.join(workspace.library.moviesRoot, "Big Buck Fixture (2008)/poster.jpg"),
          }),
        );

        const original = yield* get(artworkUrl(server.baseUrl, poster));

        assert.strictEqual(original.status, 200);
        assert.strictEqual(original.headers["content-type"], "image/jpeg");

        const resized = yield* get(artworkUrl(server.baseUrl, poster, 185));
        const image = yield* probeImage(new Uint8Array(yield* resized.arrayBuffer));

        assert.strictEqual(resized.status, 200);
        assert.deepStrictEqual([image.width, image.height], [185, 278]);
        assert.strictEqual((yield* get(`${server.baseUrl}/artwork/${poster}?w=100`)).status, 400);

        const outside = yield* keys.seal(ArtworkKeys.ArtworkSource.Local({ path: "/etc/passwd" }));

        assert.strictEqual((yield* get(artworkUrl(server.baseUrl, outside))).status, 404);
        assert.strictEqual((yield* get(`${server.baseUrl}/artwork/a1.forged`)).status, 404);
      }),
    );

    it.effect("plays a compatible MP4 directly with byte ranges and validators", () =>
      Effect.gen(function* () {
        const server = yield* MediaTestServer.Service;
        const { library } = yield* FixtureWorkspace.Service;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fileId = server.fileId("movies", library.directMovie);
        const token = signTestToken({ fid: fileId, sid: "direct" });
        const result = yield* negotiated({ token, capabilities: browser });

        assert.strictEqual(result.mode, "direct");
        assert.strictEqual(
          result.url,
          `http://media.test/media/direct/${fileId}?token=${encodeURIComponent(token)}`,
        );
        assert.strictEqual(result.video.codec, "h264");
        assert.strictEqual(result.audio?.codec, "aac");
        assert.approximately(result.durationSeconds, 12, 0.1);

        const original = yield* fs.readFile(path.join(library.moviesRoot, library.directMovie));
        const url = local(server.baseUrl, result.url);
        const partial = yield* get(url, { range: "bytes=100-1123" });

        assert.strictEqual(partial.status, 206);
        assert.strictEqual(partial.headers["content-range"], `bytes 100-1123/${original.length}`);
        assert.strictEqual(partial.headers["content-type"], "video/mp4");
        assert.deepStrictEqual(yield* bytes(partial), original.subarray(100, 1124));

        const suffix = yield* get(url, { range: "bytes=-16" });

        assert.deepStrictEqual(yield* bytes(suffix), original.subarray(original.length - 16));

        const unsatisfiable = yield* get(url, { range: `bytes=${original.length}-` });

        assert.strictEqual(unsatisfiable.status, 416);
        assert.strictEqual(unsatisfiable.headers["content-range"], `bytes */${original.length}`);

        const full = yield* get(url);
        const etag = full.headers["etag"] ?? "";

        assert.strictEqual(full.status, 200);
        assert.isFalse(etag.startsWith("W/"));
        assert.strictEqual((yield* bytes(full)).length, original.length);

        const notModified = yield* get(url, { "if-none-match": etag });

        assert.strictEqual(notModified.status, 304);
        const staleRange = yield* get(url, { range: "bytes=0-9", "if-range": '"stale"' });

        assert.strictEqual(staleRange.status, 200);

        const head = yield* HttpClient.execute(HttpClientRequest.head(url)).pipe(Effect.orDie);

        assert.strictEqual(head.status, 200);
        assert.strictEqual(head.headers["content-length"], String(original.length));
      }),
    );

    it.effect("rejects missing, forged, expired, and mismatched tokens", () =>
      Effect.gen(function* () {
        const server = yield* MediaTestServer.Service;
        const { library } = yield* FixtureWorkspace.Service;
        const fileId = server.fileId("movies", library.directMovie);
        const other = server.fileId("movies", library.messyMovie);

        assert.strictEqual((yield* get(`${server.baseUrl}/media/direct/${fileId}`)).status, 401);

        const expired = yield* get(
          `${server.baseUrl}/media/direct/${fileId}?token=${signTestToken({ fid: fileId, exp: Date.now() - 1 })}`,
        );

        assert.strictEqual(expired.status, 401);
        assert.deepStrictEqual(yield* json(expired), {
          _tag: "PlaybackTokenInvalid",
          reason: "expired",
          message: "Playback token has expired",
        });

        const valid = signTestToken({ fid: fileId });
        const middle = valid.length - 10;
        const forged = `${valid.slice(0, middle)}${valid[middle] === "A" ? "B" : "A"}${valid.slice(middle + 1)}`;

        assert.strictEqual(
          (yield* get(`${server.baseUrl}/media/direct/${fileId}?token=${forged}`)).status,
          401,
        );

        const mismatched = yield* get(
          `${server.baseUrl}/media/direct/${fileId}?token=${signTestToken({ fid: other })}`,
        );

        assert.strictEqual(mismatched.status, 403);

        const unknown = yield* negotiate({
          token: signTestToken({ fid: "no-such-file" }),
          capabilities: browser,
        });

        assert.strictEqual(unknown.status, 404);
      }),
    );

    it.effect("remuxes MKV to fMP4 HLS that ffprobe reads back", () =>
      Effect.gen(function* () {
        const server = yield* MediaTestServer.Service;
        const { library } = yield* FixtureWorkspace.Service;
        const fileId = server.fileId("movies", library.remuxMovie);

        const result = yield* negotiated({
          token: signTestToken({ fid: fileId, sid: "remux" }),
          capabilities: withDolbyAudio,
        });

        assert.strictEqual(result.mode, "remux");
        assert.strictEqual(result.generation, 1);

        const playlistUrl = local(server.baseUrl, result.url);
        const playlist = yield* get(playlistUrl);
        const text = yield* playlist.text.pipe(Effect.orDie);

        assert.strictEqual(playlist.headers["content-type"], "application/vnd.apple.mpegurl");
        assert.include(text, "#EXT-X-PLAYLIST-TYPE:VOD");
        assert.include(text, '#EXT-X-MAP:URI="init.mp4?token=');
        const durations = [...text.matchAll(/#EXTINF:([\d.]+),/g)].map((match) => Number(match[1]));

        // Keyframes every 2 s: one per segment for the first eight seconds, so playback starts
        // on a short segment, then grouped into 4 s; ffmpeg builds differ by a few milliseconds.
        assert.strictEqual(durations.length, 5);

        for (const [index, duration] of durations.entries()) {
          assert.approximately(duration, index < 4 ? 2 : 4, 0.05);
        }

        assert.include(text, "#EXT-X-ENDLIST");

        const parts = [];

        for (let index = 0; index < durations.length; index += 1) {
          const { init, segment } = yield* fetchSegment(playlistUrl, index);

          assert.strictEqual(segment.status, 200);
          const media = yield* bytes(segment);
          const probe = yield* probeBytes(concat(yield* bytes(init), media));

          assert.strictEqual(probe.video?.codec, "h264");
          assert.strictEqual(probe.audio[0]?.codec, "ac3");
          parts.push(media);
        }

        const { init } = yield* fetchSegment(playlistUrl, 0);
        const whole = yield* probeBytes(concat(yield* bytes(init), ...parts));

        assert.approximately(whole.durationSeconds, 12, 0.3);
      }),
    );

    it.effect("transcodes down to the viewer's quality cap, and plays directly within it", () =>
      Effect.gen(function* () {
        const server = yield* MediaTestServer.Service;
        const { library } = yield* FixtureWorkspace.Service;
        const fileId = server.fileId("movies", library.directMovie);

        const capped = yield* negotiated({
          token: signTestToken({ fid: fileId, sid: "quality" }),
          capabilities: browser,
          quality: { maxHeight: 120 },
        });

        assert.strictEqual(capped.mode, "transcode-software");
        assert.strictEqual(capped.video.height, 120);

        const within = yield* negotiated({
          token: signTestToken({ fid: fileId, sid: "quality" }),
          capabilities: browser,
          quality: { maxHeight: 1080, maxBitrate: 50_000_000 },
        });

        assert.strictEqual(within.mode, "direct");
      }),
    );

    it.effect("transcodes only the audio when the video can be copied", () =>
      Effect.gen(function* () {
        const server = yield* MediaTestServer.Service;
        const { library } = yield* FixtureWorkspace.Service;
        const fileId = server.fileId("movies", library.remuxMovie);

        const result = yield* negotiated({
          token: signTestToken({ fid: fileId, sid: "audio" }),
          capabilities: browser,
          audioStreamIndex: 2,
        });

        assert.strictEqual(result.mode, "audio-transcode");
        assert.deepStrictEqual(result.audio, { streamIndex: 2, codec: "aac", channels: 2 });

        const { init, segment } = yield* fetchSegment(local(server.baseUrl, result.url), 1);
        const probe = yield* probeBytes(concat(yield* bytes(init), yield* bytes(segment)));

        assert.strictEqual(probe.video?.codec, "h264");
        assert.deepStrictEqual([probe.audio[0]?.codec, probe.audio[0]?.channels], ["aac", 2]);
      }),
    );

    it.effect("tone-maps HDR to SDR in software when ffmpeg can, and refuses it otherwise", () =>
      Effect.gen(function* () {
        const server = yield* MediaTestServer.Service;
        const { library } = yield* FixtureWorkspace.Service;
        const fileId = server.fileId("movies", library.hdrMovie);
        const token = signTestToken({ fid: fileId, sid: "hdr" });
        const result = yield* negotiate({ token, capabilities: browser });

        if (!canToneMap) {
          assert.strictEqual(result.status, 422);
          assert.deepStrictEqual(result.body, {
            _tag: "UnsupportedPlayback",
            reason: "hdr-tone-mapping-requires-hardware",
          });

          return;
        }

        const stream = yield* negotiated({ token, capabilities: browser });

        assert.strictEqual(stream.mode, "transcode-software");
        assert.strictEqual(stream.video.dynamicRange, "sdr");

        const { init, segment } = yield* fetchSegment(local(server.baseUrl, stream.url), 0);
        const probe = yield* probeBytes(concat(yield* bytes(init), yield* bytes(segment)));

        assert.strictEqual(probe.video?.codec, "h264");
        assert.strictEqual(probe.video?.dynamicRange, "sdr");
        assert.strictEqual(probe.video?.bitDepth, 8);
      }),
    );

    it.effect("transcodes in software, seeks to a new generation, and rejects the old one", () =>
      Effect.gen(function* () {
        const server = yield* MediaTestServer.Service;
        const { library } = yield* FixtureWorkspace.Service;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fileId = server.fileId("movies", library.directMovie);
        const token = signTestToken({ fid: fileId, sid: "software" });
        const result = yield* negotiated({ token, capabilities: smallScreen, startSeconds: 8 });

        assert.strictEqual(result.mode, "transcode-software");
        const streamId = result.streamId ?? "";
        assert.deepStrictEqual(result.video, {
          codec: "h264",
          width: 212,
          height: 120,
          dynamicRange: "sdr",
        });
        const firstPlaylist = local(server.baseUrl, result.url);
        const started = yield* fetchSegment(firstPlaylist, 2);

        const startedProbe = yield* probeBytes(
          concat(yield* bytes(started.init), yield* bytes(started.segment)),
        );

        assert.deepStrictEqual(
          [startedProbe.video?.codec, startedProbe.video?.width, startedProbe.video?.height],
          ["h264", 212, 120],
        );

        // Segment 0 was never produced by generation 1: the request starts generation 2.
        const before = yield* fetchSegment(firstPlaylist, 0);

        assert.strictEqual(before.segment.status, 410);
        assert.deepStrictEqual(yield* json(before.segment), {
          _tag: "StreamGenerationGone",
          streamId,
          generation: 1,
          currentGeneration: 2,
        });

        assert.strictEqual((yield* get(firstPlaylist)).status, 410);
        assert.isFalse(yield* fs.exists(path.join(server.transcodeDir, streamId, "1")));

        const secondPlaylist = firstPlaylist.replace("/1/index.m3u8", "/2/index.m3u8");
        const rewound = yield* fetchSegment(secondPlaylist, 0);

        assert.strictEqual(rewound.segment.status, 200);

        const probe = yield* probeBytes(
          concat(yield* bytes(rewound.init), yield* bytes(rewound.segment)),
        );

        assert.approximately(probe.durationSeconds, 4, 0.2);

        const seek = yield* post(`${server.baseUrl}/api/playback/seek`, {
          token,
          streamId,
          positionSeconds: 1,
        });

        assert.deepStrictEqual(yield* json(seek), {
          streamId,
          generation: 2,
          playlistUrl: `http://media.test/media/hls/${streamId}/2/index.m3u8?token=${encodeURIComponent(token)}`,
        });

        const stop = yield* post(`${server.baseUrl}/api/playback/stop`, {
          token,
          streamId,
        });

        assert.strictEqual(stop.status, 204);
        assert.isFalse(yield* fs.exists(path.join(server.transcodeDir, streamId)));
        assert.strictEqual((yield* get(secondPlaylist)).status, 404);

        const events = yield* (yield* PlaybackReporter.Recording).events;

        assert.isTrue(
          events.some(
            (event) =>
              PlaybackReporter.PlaybackEvent.guards.StreamEnded(event) &&
              event.streamId === result.streamId &&
              event.reason === "stopped",
          ),
        );
      }),
    );

    it.effect("converts embedded and sidecar text subtitles to WebVTT", () =>
      Effect.gen(function* () {
        const server = yield* MediaTestServer.Service;
        const { library } = yield* FixtureWorkspace.Service;
        const fileId = server.fileId("movies", library.remuxMovie);

        const result = yield* negotiated({
          token: signTestToken({ fid: fileId, sid: "subs" }),
          capabilities: withDolbyAudio,
        });

        assert.deepStrictEqual(
          result.subtitles.map((track) => [track.id, track.source, track.language, track.forced]),
          [
            ["e3", "embedded", "eng", false],
            [sidecarTrackId("Remux Fixture (2015).en.srt"), "sidecar", "eng", false],
            [sidecarTrackId("Remux Fixture (2015).fr.forced.ass"), "sidecar", "fre", true],
          ],
        );

        const texts = [];

        for (const track of result.subtitles) {
          const response = yield* get(local(server.baseUrl, track.url ?? ""));

          assert.strictEqual(response.headers["content-type"], "text/vtt; charset=utf-8");
          texts.push(yield* response.text.pipe(Effect.orDie));
        }

        assert.isTrue(texts.every((text) => text.startsWith("WEBVTT")));
        assert.include(texts[0], "Hello from the fixture.");
        // Cue times may carry the container start offset of the ffmpeg build that made the fixture.
        assert.match(texts[0] ?? "", /00:01\.0\d\d --> 00:03\.0\d\d/);
        assert.include(texts[1], "Second");
        assert.include(texts[2], "Bonjour");
      }),
    );

    it.effect("limits how fast one address may call the unauthenticated routes", () =>
      Effect.gen(function* () {
        const server = yield* MediaTestServer.Service;

        const statuses = yield* Effect.forEach(
          Array.from({ length: 150 }, (_, index) => index),
          () => get(`${server.baseUrl}/api/health`),
          { concurrency: 16 },
        );

        const refused = statuses.filter((response) => response.status === 429);

        assert.isAbove(refused.length, 0);
        assert.isAtLeast(statuses.filter((response) => response.status === 200).length, 60);
        assert.match(refused[0]?.headers["retry-after"] ?? "", /^\d+$/);
      }),
    );

    it.effect("answers unknown streams with a recoverable error", () =>
      Effect.gen(function* () {
        const server = yield* MediaTestServer.Service;

        const response = yield* get(
          `${server.baseUrl}/media/hls/AAAAAAAAAAAAAAAAAAAAAA/1/index.m3u8?token=${signTestToken({ fid: "x" })}`,
        );

        assert.strictEqual(response.status, 404);
        assert.deepStrictEqual(yield* json(response), {
          _tag: "StreamNotFound",
          streamId: "AAAAAAAAAAAAAAAAAAAAAA",
        });
      }),
    );
  });

  layer(MediaTestServer.layer({ STREAM_IDLE_SECONDS: "1", MAX_CONCURRENT_TRANSCODES: "1" }), {
    excludeTestServices: true,
    timeout: "120 seconds",
  })("with short idle timeout and one transcode slot", (it) => {
    it.effect("limits concurrent transcodes and closes idle streams", () =>
      Effect.gen(function* () {
        const server = yield* MediaTestServer.Service;
        const { library } = yield* FixtureWorkspace.Service;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fileId = server.fileId("movies", library.directMovie);

        const first = yield* negotiated({
          token: signTestToken({ fid: fileId, sid: "one" }),
          capabilities: smallScreen,
        });

        assert.isTrue(yield* fs.exists(path.join(server.transcodeDir, first.streamId ?? "")));

        const second = yield* negotiate({
          token: signTestToken({ fid: fileId, sid: "two" }),
          capabilities: smallScreen,
        });

        assert.strictEqual(second.status, 503);
        assert.deepStrictEqual(second.body, { _tag: "TranscodeCapacityReached", limit: 1 });

        yield* Effect.sleep("2500 millis");

        assert.isFalse(yield* fs.exists(path.join(server.transcodeDir, first.streamId ?? "")));
        const events = yield* (yield* PlaybackReporter.Recording).events;

        assert.isTrue(
          events.some(
            (event) =>
              PlaybackReporter.PlaybackEvent.guards.StreamEnded(event) && event.reason === "idle",
          ),
        );

        const gone = yield* get(local(server.baseUrl, first.url));

        assert.strictEqual(gone.status, 404);

        const logged = server.logged();

        assert.isTrue(
          logged.some(
            (entry) =>
              entry.message === "Stream.ended" &&
              entry.annotations["reason"] === "idle" &&
              entry.annotations["sessionId"] === "one",
          ),
        );

        assert.deepInclude(
          logged.find((entry) => entry.message === "MediaRoutes.request_failed")?.annotations,
          {
            route: "playlist",
            status: 404,
            error: "Stream not found: renegotiate playback",
            streamId: first.streamId,
            sessionId: "one",
            userId: "user_test",
          },
        );
        assert.strictEqual(
          logged.find((entry) => entry.message === "MediaRoutes.request_failed")?.level,
          "WARN",
        );

        const retry = yield* negotiated({
          token: signTestToken({ fid: fileId, sid: "two" }),
          capabilities: smallScreen,
        });

        assert.strictEqual(retry.mode, "transcode-software");
      }),
    );
  });

  layer(
    MediaTestServer.layer({
      HARDWARE_ACCELERATION: "qsv",
      QSV_DEVICE: "/dev/dri/no-such-render-node",
    }),
    {
      excludeTestServices: true,
      timeout: "120 seconds",
    },
  )("when QSV fails", (it) => {
    it.effect("falls back to software and reports the mode change", () =>
      Effect.gen(function* () {
        const server = yield* MediaTestServer.Service;
        const { library } = yield* FixtureWorkspace.Service;
        const fileId = server.fileId("movies", library.directMovie);

        const result = yield* negotiated({
          token: signTestToken({ fid: fileId, sid: "fallback" }),
          capabilities: smallScreen,
        });

        assert.strictEqual(result.mode, "transcode-software");
        const { segment } = yield* fetchSegment(local(server.baseUrl, result.url), 0);

        assert.strictEqual(segment.status, 200);
        const events = yield* (yield* PlaybackReporter.Recording).events;

        assert.isTrue(
          events.some(
            (event) =>
              PlaybackReporter.PlaybackEvent.guards.ModeChanged(event) &&
              event.from === "transcode-qsv" &&
              event.to === "transcode-software",
          ),
        );

        const health = yield* get(`${server.baseUrl}/api/health`);

        const status = yield* decodeHealth(yield* json(health)).pipe(Effect.orDie);

        assert.strictEqual(status.hardwareAcceleration, "none");
      }),
    );
  });

  layer(MediaTestServer.layer({ LOG_LEVEL: "debug" }), {
    excludeTestServices: true,
    timeout: "120 seconds",
  })("with debug logs", (it) => {
    it.effect("times every segment: encoder wait, disk read, and network write", () =>
      Effect.gen(function* () {
        const server = yield* MediaTestServer.Service;
        const { library } = yield* FixtureWorkspace.Service;

        const stream = yield* negotiated({
          token: signTestToken({ fid: server.fileId("movies", library.remuxMovie), sid: "timed" }),
          capabilities: browser,
        });

        const { segment } = yield* fetchSegment(local(server.baseUrl, stream.url), 0);
        const body = yield* bytes(segment);

        const timed = yield* Effect.sync(() =>
          server
            .logged()
            .find(
              (entry) =>
                entry.message === "MediaRoutes.segment" && entry.annotations["segment"] === 0,
            ),
        ).pipe(
          Effect.repeat({ until: (entry) => entry !== undefined, schedule: Schedule.spaced(20) }),
          Effect.timeout("5 seconds"),
          Effect.orDie,
        );

        assert.deepInclude(timed?.annotations, {
          route: "hls",
          streamId: stream.streamId,
          sessionId: "timed",
          bytes: body.length,
          completed: true,
        });

        for (const part of ["elapsedMs", "encoderWaitMs", "diskReadMs", "networkWriteMs"]) {
          assert.isAtLeast(Number(timed?.annotations[part]), 0, part);
        }
      }),
    );

    it.effect("takes a player's events, and refuses batches outside the limits", () =>
      Effect.gen(function* () {
        const server = yield* MediaTestServer.Service;
        const token = signTestToken({ fid: "file_1", sid: "reported" });

        const observation = {
          _tag: "BufferingStarted",
          positionSeconds: 1,
          bufferedAheadSeconds: 0,
        };

        const stall = { ageMs: 0, observation };

        const send = (body: WireBatch) =>
          HttpClient.execute(
            HttpClientRequest.post(`${server.baseUrl}/api/playback/diagnostics`).pipe(
              HttpClientRequest.bodyJsonUnsafe(body),
            ),
          ).pipe(Effect.orDie);

        assert.strictEqual((yield* send({ token, platform: "web", events: [stall] })).status, 204);
        assert.isTrue(
          server
            .logged()
            .some(
              (entry) =>
                entry.message === "Player.buffering_started" &&
                entry.annotations["sessionId"] === "reported",
            ),
        );

        const tooMany = Array.from({ length: 101 }, () => stall);

        assert.strictEqual((yield* send({ token, platform: "web", events: tooMany })).status, 400);
        assert.strictEqual(
          (yield* send({
            token,
            platform: "web",
            events: [{ ageMs: 0, observation: { ...observation, _tag: "Unknown" } }],
          })).status,
          400,
        );
        assert.strictEqual(
          (yield* send({ token, platform: "web", events: [{ ...stall, ageMs: 3_600_000 }] }))
            .status,
          400,
        );
        assert.strictEqual(
          (yield* send({ token: "v1.forged.token", platform: "web", events: [stall] })).status,
          401,
        );
      }),
    );
  });

  layer(MediaTestServer.layer({ CONVEX_PUBLIC_URL: "https://convex.example.com/" }), {
    excludeTestServices: true,
    timeout: "120 seconds",
  })("with a public Convex URL", (it) => {
    it.effect("tells apps where to sign in", () =>
      Effect.gen(function* () {
        const server = yield* MediaTestServer.Service;
        const response = yield* get(`${server.baseUrl}/api/client-config`);

        assert.deepStrictEqual(yield* json(response), { convexUrl: "https://convex.example.com" });
      }),
    );
  });

  layer(
    MediaTestServer.layer({
      HARDWARE_ACCELERATION: "auto",
      FFMPEG_PATH: process.env["FFMPEG_PATH"] ?? "ffmpeg",
      QSV_DEVICE: process.env["QSV_DEVICE"] ?? "/dev/dri/renderD128",
    }),
    { excludeTestServices: true, timeout: "120 seconds" },
  )("on Intel Quick Sync hardware", (it) => {
    it.effect.skipIf(!hasQsv)("tone-maps HDR10 HEVC to SDR H.264", () =>
      Effect.gen(function* () {
        const server = yield* MediaTestServer.Service;
        const { library } = yield* FixtureWorkspace.Service;
        const fileId = server.fileId("movies", library.hdrMovie);

        const result = yield* negotiated({
          token: signTestToken({ fid: fileId, sid: "qsv" }),
          capabilities: browser,
        });

        assert.strictEqual(result.mode, "transcode-qsv");
        assert.deepStrictEqual(result.video, {
          codec: "h264",
          width: 320,
          height: 180,
          dynamicRange: "sdr",
        });
        const { init, segment } = yield* fetchSegment(local(server.baseUrl, result.url), 0);
        const probe = yield* probeBytes(concat(yield* bytes(init), yield* bytes(segment)));

        assert.deepStrictEqual(
          [probe.video?.codec, probe.video?.bitDepth, probe.video?.dynamicRange],
          ["h264", 8, "sdr"],
        );
      }),
    );
  });

  layer(
    MediaTestServer.layer({
      HARDWARE_ACCELERATION: "vaapi",
      FFMPEG_PATH: process.env["FFMPEG_PATH"] ?? "ffmpeg",
      VAAPI_DEVICE: process.env["VAAPI_DEVICE"] ?? "/dev/dri/renderD128",
    }),
    { excludeTestServices: true, timeout: "120 seconds" },
  )("on VA-API hardware", (it) => {
    it.effect.skipIf(!hasVaapi)("tone-maps HDR10 HEVC to SDR H.264", () =>
      Effect.gen(function* () {
        const server = yield* MediaTestServer.Service;
        const { library } = yield* FixtureWorkspace.Service;
        const fileId = server.fileId("movies", library.hdrMovie);

        const result = yield* negotiated({
          token: signTestToken({ fid: fileId, sid: "vaapi" }),
          capabilities: browser,
        });

        assert.strictEqual(result.mode, "transcode-vaapi");
        const { init, segment } = yield* fetchSegment(local(server.baseUrl, result.url), 0);
        const probe = yield* probeBytes(concat(yield* bytes(init), yield* bytes(segment)));

        assert.deepStrictEqual(
          [probe.video?.codec, probe.video?.bitDepth, probe.video?.dynamicRange],
          ["h264", 8, "sdr"],
        );
      }),
    );
  });
});
