/**
 * Byte routes for players: direct files with single byte ranges, HLS playlists, init segments
 * and media segments, and WebVTT subtitles. Every request carries a playback token in the
 * `token` query parameter; the file comes from the token, never from the URL path alone.
 * Expected failures become JSON bodies encoded with their error schema and status.
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
import { Effect, FileSystem, Layer, Match, Option, Path, Redacted, Schema } from "effect";
import { HttpPlatform, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as MediaConfig from "../media-config.ts";
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

const concatBytes = (parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;

  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }

  return out;
};

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

    const resolve = (fileId: MediaFileId) =>
      resolveInsideRoots(fileId).pipe(
        Effect.provideService(FileResolver.Service, resolver),
        Effect.provideService(MediaConfig.Service, config),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );

    const grantFor = Effect.fnUntraced(function* (request: HttpServerRequest.HttpServerRequest) {
      return yield* verifier.verify(yield* tokenOf(request));
    });

    /** Serves `file` with validators and a single byte range. */
    const fileResponse = Effect.fnUntraced(
      function* (request: HttpServerRequest.HttpServerRequest, file: string, contentType: string) {
        const info = yield* fs.stat(file);
        const size = Number(info.size);

        const modified = Option.match(info.mtime, {
          onNone: () => 0,
          onSome: (date) => date.getTime(),
        });

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

    const direct = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;

      if (request.method !== "GET" && request.method !== "HEAD") {
        return HttpServerResponse.empty({ status: 405, headers: { allow: "GET, HEAD" } });
      }

      const { fileId = "" } = yield* HttpRouter.params;
      const grant = yield* grantFor(request);

      if (grant.fileId !== fileId) return yield* new MediaAccessDenied();
      const file = yield* resolve(grant.fileId);

      return yield* fileResponse(request, file.path, CONTENT_TYPES[file.probe.container]);
    }).pipe(Effect.catch(errorResponse), Effect.withSpan("MediaRoutes.direct"));

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

    const playlist = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const { streamId, generation } = yield* streamParams;
      const token = yield* tokenOf(request);
      const grant = yield* verifier.verify(token);
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
    }).pipe(Effect.catch(errorResponse), Effect.withSpan("MediaRoutes.playlist"));

    const hlsFile = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const { streamId, generation, file } = yield* streamParams;
      const grant = yield* grantFor(request);
      const segmentMatch = /^(\d+)\.m4s$/.exec(file);

      if (file !== "init.mp4" && segmentMatch === null)
        return yield* new SegmentNotFound({ index: -1 });
      const segmentIndex = segmentMatch === null ? -1 : Number(segmentMatch[1]);

      const parts =
        segmentMatch === null
          ? yield* sessions.init(streamId, generation, grant)
          : yield* sessions.segment(streamId, generation, segmentIndex, grant);

      // Read every part before answering: a seek may delete this generation's folder at any
      // moment, and a body cut short under a promised length breaks the player's parser.
      const body = yield* Effect.forEach(parts.paths, (part) => fs.readFile(part)).pipe(
        Effect.map(concatBytes),
        Effect.mapError(() => new SegmentNotReady({ index: segmentIndex })),
      );

      return HttpServerResponse.uint8Array(body, {
        contentType: "video/mp4",
        headers: { "cache-control": SEGMENT_CACHE },
      });
    }).pipe(Effect.catch(errorResponse), Effect.withSpan("MediaRoutes.hls"));

    const subtitle = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const { fileId = "", track = "" } = yield* HttpRouter.params;
      const grant = yield* grantFor(request);

      if (grant.fileId !== fileId) return yield* new MediaAccessDenied();
      const file = yield* resolve(grant.fileId);
      const vtt = yield* subtitles.toWebVtt(file, track.replace(/\.vtt$/, ""));

      return HttpServerResponse.text(vtt, {
        contentType: "text/vtt; charset=utf-8",
        headers: { "cache-control": SEGMENT_CACHE },
      });
    }).pipe(Effect.catch(errorResponse), Effect.withSpan("MediaRoutes.subtitle"));

    yield* router.add("*", "/media/direct/:fileId", direct);
    yield* router.add("GET", "/media/hls/:streamId/:generation/index.m3u8", playlist);
    yield* router.add("GET", "/media/hls/:streamId/:generation/:file", hlsFile);
    yield* router.add("GET", "/media/subtitles/:fileId/:track", subtitle);
  }),
);
