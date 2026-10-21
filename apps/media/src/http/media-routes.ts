/**
 * Byte routes for players: direct files with single byte ranges, HLS playlists, init segments
 * and media segments, the MP4s written for downloads (byte ranges too), and WebVTT subtitles.
 * Every request carries a playback token in the `token` query parameter; the file comes from the
 * token, never from the URL path alone. HLS takes only playback tokens and download MP4s only
 * download tokens. Expected failures become JSON bodies encoded with their error schema and
 * status.
 *
 * Every answer with a 4xx or 5xx status logs `MediaRoutes.request_failed`: at `WARN` with the
 * session once the token is verified, within a per-session and per-account budget
 * (`failure-budget.ts`), and at `DEBUG` otherwise. Every HLS segment logs how long it took, split
 * into waiting for the encoder, reading the disk, and writing to the network: at `WARN` from one
 * second (`MediaRoutes.slow_segment`), at `DEBUG` below.
 */
import type { MediaFileId } from "@movies/contracts/ids";
import {
  type Container,
  FileResolverUnavailable,
  MediaFileNotFound,
  PlaybackSessionEnded,
  SegmentNotFound,
  SegmentNotReady,
  StreamAccessDenied,
  StreamGenerationGone,
  StreamId,
  StreamNotFound,
  TranscodeFailed,
  UnsupportedPlayback,
} from "@movies/contracts/media-playback";
import { PlaybackTokenInvalid } from "@movies/contracts/playback-token";
import {
  Clock,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Match,
  Option,
  Path,
  Redacted,
  Ref,
  Schedule,
  Schema,
  Stream,
} from "effect";
import {
  HttpEffect,
  HttpPlatform,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import { grantAnnotations, LogEvent, SLOW_MS } from "../diagnostics/log-events.ts";
import * as Downloads from "../downloads/downloads.ts";
import * as MediaConfig from "../media-config.ts";
import { modifiedAtMs } from "../platform/file-info.ts";
import * as FileResolver from "../playback/file-resolver.ts";
import { resolveInsideRoots } from "../playback/file-resolver.ts";
import { renderPlaylist } from "../playback/hls-plan.ts";
import * as PlaybackToken from "../playback/playback-token.ts";
import * as StreamSessions from "../playback/stream-sessions.ts";
import * as SubtitleConverter from "../subtitles/subtitle-tracks.ts";
import {
  SubtitleConversionFailed,
  SubtitleTrackNotFound,
  SubtitleUnsupported,
} from "../subtitles/subtitle-tracks.ts";
import { ByteRange, parseByteRange } from "./byte-range.ts";
import { type FailureBudget, makeFailureBudget } from "./failure-budget.ts";
import { playbackTokenOf as tokenOf } from "./playback-token-param.ts";

/** The token is valid but for another file. */
class MediaAccessDenied extends Schema.TaggedError<MediaAccessDenied>()(
  "MediaAccessDenied",
  {},
  { httpApiStatus: 403 },
) {
  override get message(): string {
    return "Media access denied: the token is for another file";
  }
}

/** The resolved file could not be read from disk. */
class MediaFileUnreadable extends Schema.TaggedError<MediaFileUnreadable>()(
  "MediaFileUnreadable",
  {},
  { httpApiStatus: 503 },
) {
  override get message(): string {
    return "Media file unreadable: the library may be offline";
  }
}

/** Every failure a media route can answer with. */
const RouteError = Schema.Union([
  PlaybackTokenInvalid,
  PlaybackSessionEnded,
  MediaAccessDenied,
  MediaFileNotFound,
  MediaFileUnreadable,
  FileResolverUnavailable,
  StreamNotFound,
  StreamAccessDenied,
  StreamGenerationGone,
  SegmentNotFound,
  SegmentNotReady,
  TranscodeFailed,
  UnsupportedPlayback,
  SubtitleTrackNotFound,
  SubtitleUnsupported,
  SubtitleConversionFailed,
]);

type RouteError = typeof RouteError.Type;

const encodeRouteError = Schema.encodeEffect(Schema.toCodecJson(RouteError));

const statusOf = Match.valueTags<RouteError, Record<RouteError["_tag"], () => number>>({
  PlaybackTokenInvalid: () => 401,
  PlaybackSessionEnded: () => 410,
  MediaAccessDenied: () => 403,
  MediaFileNotFound: () => 404,
  MediaFileUnreadable: () => 503,
  FileResolverUnavailable: () => 503,
  StreamNotFound: () => 404,
  StreamAccessDenied: () => 403,
  StreamGenerationGone: () => 410,
  SegmentNotFound: () => 404,
  SegmentNotReady: () => 503,
  TranscodeFailed: () => 500,
  UnsupportedPlayback: () => 422,
  SubtitleTrackNotFound: () => 404,
  SubtitleUnsupported: () => 415,
  SubtitleConversionFailed: () => 500,
});

const errorResponse = (error: RouteError) =>
  encodeRouteError(error).pipe(
    Effect.orDie,
    Effect.map((body) =>
      HttpServerResponse.jsonUnsafe(body, {
        status: statusOf(error),
        headers: { "cache-control": "no-store" },
      }),
    ),
  );

const CONTENT_TYPES: Readonly<Record<Container, string>> = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  webm: "video/webm",
  avi: "video/x-msvideo",
  ts: "video/mp2t",
  other: "application/octet-stream",
};

const SEGMENT_CACHE = "private, max-age=3600";

/** How much of a segment part is read at a time. */
const READ_CHUNK = 256 * 1024;

/** The first `size` bytes of an open file, in chunks, adding the time spent reading to `readMs`. */
const readWhole = (handle: FileSystem.File, size: number, readMs: Ref.Ref<number>) =>
  Stream.paginate(0, (position: number) =>
    handle.readAlloc(Math.min(READ_CHUNK, size - position), { position: BigInt(position) }).pipe(
      Effect.timed,
      Effect.tap(([elapsed]) => Ref.update(readMs, (total) => total + Duration.toMillis(elapsed))),
      Effect.map(([, chunk]) => {
        const bytes = Option.getOrElse(chunk, () => new Uint8Array(0));
        const next = position + bytes.length;

        return [
          bytes.length === 0 ? [] : [bytes],
          bytes.length === 0 || next >= size ? Option.none<number>() : Option.some(next),
        ] as const;
      }),
    ),
  );

/** What a media route answered, and the message of the failure it answered with, if any. */
interface Answer {
  readonly response: HttpServerResponse.HttpServerResponse;
  readonly error: Option.Option<string>;
}

/** Records the grant of a request's token once it is verified, for its log records. */
type Remember = (grant: PlaybackToken.PlaybackGrant) => Effect.Effect<void>;

/** The longest path parameter a failure record keeps: a stream ID or file name is far shorter. */
const MAX_LOGGED_PARAM = 64;

/** How often the failures past a session's budget are logged as counts. */
const SUPPRESSED_REPORT_INTERVAL = Duration.seconds(30);

/** A path parameter as a failure record keeps it: cut to `MAX_LOGGED_PARAM` characters. */
const loggedParam = (value: string | undefined): string | null =>
  value === undefined
    ? null
    : value.length > MAX_LOGGED_PARAM
      ? `${value.slice(0, MAX_LOGGED_PARAM)}…`
      : value;

/**
 * Runs a media route: failures become their error responses, and any answer with a 4xx or 5xx
 * status logs `MediaRoutes.request_failed` with the route, the stream in the path, and the
 * session of the verified token. It logs at `WARN` while the session's `budget` allows, and at
 * `DEBUG` when no token was verified or the budget is spent; the budget counts those instead.
 */
const observed = <R>(
  budget: FailureBudget,
  route: string,
  handler: (
    remember: Remember,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, RouteError, R>,
) =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis;
    const verified = yield* Ref.make(Option.none<PlaybackToken.PlaybackGrant>());
    const params = yield* HttpRouter.params;

    const answer = yield* handler((grant) => Ref.set(verified, Option.some(grant))).pipe(
      Effect.map((response): Answer => ({ response, error: Option.none() })),
      Effect.catch((error) =>
        errorResponse(error).pipe(
          Effect.map((response): Answer => ({ response, error: Option.some(error.message) })),
        ),
      ),
    );

    if (answer.response.status >= 400) {
      const grant = yield* Ref.get(verified);
      const now = yield* Clock.currentTimeMillis;

      // Anyone can send a bad token, and a member any number of bad requests: only a player's own
      // failures, within its budget, may fill the retained log.
      yield* (
        Option.exists(grant, (verifiedGrant) => budget.allow(verifiedGrant, now))
          ? Effect.logWarning(LogEvent.requestFailed)
          : Effect.logDebug(LogEvent.requestFailed)
      ).pipe(
        Effect.annotateLogs({
          route,
          status: answer.response.status,
          error: Option.getOrNull(answer.error),
          elapsedMs: now - started,
          streamId: loggedParam(params["streamId"]),
          file: loggedParam(params["file"]),
          ...Option.match(grant, { onNone: () => ({}), onSome: grantAnnotations }),
        }),
      );
    }

    return answer.response;
  });

const matchesEtag = (header: string, etag: string): boolean =>
  header.trim() === "*" ||
  header.split(",").some((candidate) => candidate.trim().replace(/^W\//, "") === etag);

/** Adds the routes. */
export const layer: Layer.Layer<
  never,
  never,
  | HttpRouter.HttpRouter
  | MediaConfig.Service
  | PlaybackToken.Service
  | FileResolver.Service
  | StreamSessions.Service
  | SubtitleConverter.Service
  | Downloads.Service
  | FileSystem.FileSystem
  | Path.Path
  | HttpPlatform.HttpPlatform
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const router = yield* HttpRouter.HttpRouter;
    const verifier = yield* PlaybackToken.Service;
    const sessions = yield* StreamSessions.Service;
    const subtitles = yield* SubtitleConverter.Service;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* MediaConfig.Service;
    const resolver = yield* FileResolver.Service;
    const platform = yield* HttpPlatform.HttpPlatform;
    const downloads = yield* Downloads.Service;
    const budget = makeFailureBudget();

    const reportSuppressed = Effect.suspend(() =>
      Effect.forEach(
        budget.drain(),
        ({ sessionId, userId, count }) =>
          Effect.logWarning(LogEvent.requestFailuresSuppressed).pipe(
            Effect.annotateLogs({ sessionId, userId, failures: count }),
          ),
        { discard: true },
      ),
    );

    yield* Effect.forkScoped(
      Effect.repeat(Effect.delay(reportSuppressed, SUPPRESSED_REPORT_INTERVAL), Schedule.forever),
    );

    const resolve = (fileId: MediaFileId, options: { readonly sidecars: boolean }) =>
      resolveInsideRoots(fileId, options).pipe(
        Effect.provideService(FileResolver.Service, resolver),
        Effect.provideService(MediaConfig.Service, config),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );

    const grantFor = Effect.fnUntraced(function* (
      request: HttpServerRequest.HttpServerRequest,
      purposes: ReadonlyArray<PlaybackToken.TokenPurpose>,
    ) {
      return yield* verifier.verify(yield* tokenOf(request), purposes);
    });

    /** Serves `file` with validators and a single byte range. */
    const fileResponse = Effect.fnUntraced(
      function* (request: HttpServerRequest.HttpServerRequest, file: string, contentType: string) {
        const info = yield* fs.stat(file);
        const size = Number(info.size);

        const modified = modifiedAtMs(info);

        const etag = `"${size.toString(36)}-${Math.trunc(modified).toString(36)}"`;
        const lastModified = new Date(modified).toUTCString();

        const headers = {
          "accept-ranges": "bytes",
          "cache-control": SEGMENT_CACHE,
          "content-type": contentType,
          "last-modified": lastModified,
        };

        const ifNoneMatch = request.headers["if-none-match"];

        if (ifNoneMatch !== undefined && matchesEtag(ifNoneMatch, etag)) {
          return HttpServerResponse.empty({ status: 304, headers: { ...headers, etag } });
        }

        const ifRange = request.headers["if-range"];
        const rangeAllowed = ifRange === undefined || ifRange === etag || ifRange === lastModified;
        const range = parseByteRange(rangeAllowed ? request.headers["range"] : undefined, size);

        const response = yield* ByteRange.$match(range, {
          Full: () => platform.fileResponse(file, { headers }),
          Partial: ({ start, end }) =>
            platform.fileResponse(file, {
              status: 206,
              offset: start,
              bytesToRead: end - start + 1,
              headers: { ...headers, "content-range": `bytes ${start}-${end}/${size}` },
            }),
          Unsatisfiable: () =>
            Effect.succeed(
              HttpServerResponse.empty({
                status: 416,
                headers: { ...headers, "content-range": `bytes */${size}` },
              }),
            ),
        });

        // The platform adds a weak ETag; `If-Range` needs this strong one.
        return HttpServerResponse.setHeader(response, "etag", etag);
      },
      Effect.mapError(() => new MediaFileUnreadable()),
    );

    const direct = observed(budget, "direct", (remember) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;

        if (request.method !== "GET" && request.method !== "HEAD") {
          return HttpServerResponse.empty({ status: 405, headers: { allow: "GET, HEAD" } });
        }

        const { fileId = "" } = yield* HttpRouter.params;
        const grant = yield* grantFor(request, PlaybackToken.PLAY_OR_DOWNLOAD);

        yield* remember(grant);

        if (grant.fileId !== fileId) return yield* new MediaAccessDenied();
        const file = yield* resolve(grant.fileId, { sidecars: false });

        return yield* fileResponse(request, file.path, CONTENT_TYPES[file.probe.container]);
      }),
    ).pipe(Effect.withSpan("MediaRoutes.direct"));

    const download = observed(budget, "download", (remember) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;

        if (request.method !== "GET" && request.method !== "HEAD") {
          return HttpServerResponse.empty({ status: 405, headers: { allow: "GET, HEAD" } });
        }

        const { fileId = "", name = "" } = yield* HttpRouter.params;
        const grant = yield* grantFor(request, PlaybackToken.DOWNLOAD);

        yield* remember(grant);

        if (grant.fileId !== fileId) return yield* new MediaAccessDenied();
        // Gone after a restart or six idle hours: preparing the download again writes it again.
        const output = yield* downloads.output(grant.fileId, name);

        if (Option.isNone(output)) return yield* new MediaFileNotFound({ fileId: grant.fileId });

        return yield* fileResponse(request, output.value, CONTENT_TYPES.mp4);
      }),
    ).pipe(Effect.withSpan("MediaRoutes.download"));

    const streamParams = Effect.gen(function* () {
      const params = yield* HttpRouter.params;

      const streamId = yield* Schema.decodeUnknownEffect(StreamId)(params["streamId"]).pipe(
        Effect.mapError(() => new StreamNotFound({ streamId: "" })),
      );

      const generation = Number(params["generation"]);

      return {
        streamId,
        generation: Number.isInteger(generation) ? generation : -1,
        file: params["file"] ?? "",
      };
    });

    const playlist = observed(budget, "playlist", (remember) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const { streamId, generation } = yield* streamParams;
        const token = yield* tokenOf(request);
        const grant = yield* verifier.verify(token, PlaybackToken.PLAY);

        yield* remember(grant);
        const view = yield* sessions.playlist(streamId, generation, grant);
        const query = `?token=${encodeURIComponent(Redacted.value(token))}`;

        const body = renderPlaylist(view.plan, {
          init: `init.mp4${query}`,
          segment: (index) => `${index}.m4s${query}`,
        });

        return HttpServerResponse.text(body, {
          contentType: "application/vnd.apple.mpegurl",
          headers: { "cache-control": "no-store" },
        });
      }),
    ).pipe(Effect.withSpan("MediaRoutes.playlist"));

    const hlsFile = observed(budget, "hls", (remember) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const { streamId, generation, file } = yield* streamParams;
        const grant = yield* grantFor(request, PlaybackToken.PLAY);

        yield* remember(grant);
        const segmentMatch = /^(\d+)\.m4s$/.exec(file);

        if (file !== "init.mp4" && segmentMatch === null)
          return yield* new SegmentNotFound({ index: -1 });
        const segmentIndex = segmentMatch === null ? -1 : Number(segmentMatch[1]);
        const started = yield* Clock.currentTimeMillis;

        const parts =
          segmentMatch === null
            ? yield* sessions.init(streamId, generation, grant)
            : yield* sessions.segment(streamId, generation, segmentIndex, grant);

        const produced = yield* Clock.currentTimeMillis;
        const readMs = yield* Ref.make(0);

        // Open every part before answering: a seek may delete this generation's folder at any
        // moment, and a body cut short under its promised length breaks the player's parser. An
        // open file stays readable after it is deleted; the request's scope closes the handles
        // once the body is sent.
        const opened = yield* Effect.forEach(parts.paths, (part) =>
          fs
            .open(part)
            .pipe(
              Effect.flatMap((handle) =>
                handle.stat.pipe(Effect.map((info) => ({ handle, size: Number(info.size) }))),
              ),
            ),
        ).pipe(Effect.mapError(() => new SegmentNotReady({ index: segmentIndex })));

        const answered = yield* Clock.currentTimeMillis;
        const contentLength = opened.reduce((total, part) => total + part.size, 0);

        // The request's scope closes once the body is sent or the player hangs up.
        yield* Effect.addFinalizer((exit) =>
          Effect.gen(function* () {
            const finished = yield* Clock.currentTimeMillis;
            const bodyReadMs = yield* Ref.get(readMs);
            const elapsedMs = finished - started;

            const timing = {
              route: "hls",
              streamId,
              generation,
              segment: segmentMatch === null ? "init" : segmentIndex,
              elapsedMs,
              encoderWaitMs: produced - started,
              diskReadMs: answered - produced + bodyReadMs,
              networkWriteMs: Math.max(0, finished - answered - bodyReadMs),
              bytes: contentLength,
              completed: Exit.isSuccess(exit),
              ...grantAnnotations(grant),
            };

            yield* (
              elapsedMs >= SLOW_MS
                ? Effect.logWarning(LogEvent.slowSegment)
                : Effect.logDebug(LogEvent.segmentServed)
            ).pipe(Effect.annotateLogs(timing));
          }),
        );

        const body = Stream.fromIterable(opened).pipe(
          Stream.flatMap(({ handle, size }) => readWhole(handle, size, readMs)),
        );

        return HttpEffect.scopeTransferToStream(
          HttpServerResponse.stream(body, {
            contentType: "video/mp4",
            contentLength,
            headers: { "cache-control": SEGMENT_CACHE },
          }),
        );
      }),
    ).pipe(Effect.withSpan("MediaRoutes.hls"));

    const subtitle = observed(budget, "subtitle", (remember) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const { fileId = "", track = "" } = yield* HttpRouter.params;
        const grant = yield* grantFor(request, PlaybackToken.PLAY_OR_DOWNLOAD);

        yield* remember(grant);

        if (grant.fileId !== fileId) return yield* new MediaAccessDenied();
        const file = yield* resolve(grant.fileId, { sidecars: true });
        const vtt = yield* subtitles.toWebVtt(file, track.replace(/\.vtt$/, ""));

        return HttpServerResponse.text(vtt, {
          contentType: "text/vtt; charset=utf-8",
          headers: { "cache-control": SEGMENT_CACHE },
        });
      }),
    ).pipe(Effect.withSpan("MediaRoutes.subtitle"));

    yield* router.add("*", "/media/direct/:fileId", direct);
    yield* router.add("*", "/media/downloads/:fileId/:name", download);
    yield* router.add("GET", "/media/hls/:streamId/:generation/index.m3u8", playlist);
    yield* router.add("GET", "/media/hls/:streamId/:generation/:file", hlsFile);
    yield* router.add("GET", "/media/subtitles/:fileId/:track", subtitle);
  }),
);
