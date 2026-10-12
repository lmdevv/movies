/**
 * The subtitle tracks of a media file as clients see them: embedded streams and sidecar files,
 * each with a stable ID used in subtitle URLs (`e<stream index>` or `x<sidecar position>`), and
 * their conversion to WebVTT. Text formats convert; bitmap formats (PGS, VobSub) are listed as
 * unsupported. ASS/SSA styling is dropped to plain text with basic emphasis.
 */
import { Context, Duration, Effect, FileSystem, Layer, Option, Schema } from "effect";

import * as DiskCache from "../disk-cache.ts";
import * as MediaTools from "../media/media-tools.ts";
import type { ResolvedMediaFile } from "../playback/file-resolver.ts";

/** One subtitle track a client can choose. */
export const SubtitleTrack = Schema.Struct({
  /** Stable ID within the file: `e<stream index>` for embedded, `x<position>` for sidecar files. */
  id: Schema.String,
  source: Schema.Literals(["embedded", "sidecar"]),
  /** ffmpeg codec name or sidecar extension, such as `subrip`, `ass`, or `hdmv_pgs_subtitle`. */
  codec: Schema.String,
  kind: Schema.Literals(["text", "bitmap"]),
  language: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  forced: Schema.Boolean,
  default: Schema.Boolean,
  hearingImpaired: Schema.Boolean,
});

/** One subtitle track a client can choose. */
export interface SubtitleTrack extends Schema.Schema.Type<typeof SubtitleTrack> {}

/** Every subtitle track of `file`, embedded first. */
export const subtitleTracks = (file: ResolvedMediaFile): ReadonlyArray<SubtitleTrack> => [
  ...file.probe.subtitles.map((subtitle): SubtitleTrack => ({
    id: `e${subtitle.index}`,
    source: "embedded",
    codec: subtitle.codec,
    kind: subtitle.kind,
    language: subtitle.language,
    title: subtitle.title,
    forced: subtitle.forced,
    default: subtitle.default,
    hearingImpaired: subtitle.hearingImpaired,
  })),
  ...file.subtitles.map((subtitle, position): SubtitleTrack => ({
    id: `x${position}`,
    source: "sidecar",
    codec: subtitle.format,
    kind: "text",
    language: subtitle.language,
    title: subtitle.title,
    forced: subtitle.forced,
    default: subtitle.default,
    hearingImpaired: subtitle.hearingImpaired,
  })),
];

/** The file has no subtitle track with this ID. */
export class SubtitleTrackNotFound extends Schema.TaggedError<SubtitleTrackNotFound>()(
  "SubtitleTrackNotFound",
  { trackId: Schema.String },
  { httpApiStatus: 404 },
) {
  override get message(): string {
    return `Subtitle track not found: ${this.trackId}`;
  }
}

/** The track is a bitmap format, which cannot become WebVTT. */
export class SubtitleUnsupported extends Schema.TaggedError<SubtitleUnsupported>()(
  "SubtitleUnsupported",
  { trackId: Schema.String, codec: Schema.String },
  { httpApiStatus: 415 },
) {
  override get message(): string {
    return `Subtitle unsupported: ${this.codec} is a bitmap format`;
  }
}

/** ffmpeg could not convert the track. */
export class SubtitleConversionFailed extends Schema.TaggedError<SubtitleConversionFailed>()(
  "SubtitleConversionFailed",
  { trackId: Schema.String, detail: Schema.String },
  { httpApiStatus: 500 },
) {
  override get message(): string {
    return `Subtitle conversion failed for ${this.trackId}: ${this.detail}`;
  }
}

/** Converts subtitle tracks to WebVTT. */
export interface Interface {
  readonly toWebVtt: (
    file: ResolvedMediaFile,
    trackId: string,
  ) => Effect.Effect<
    string,
    SubtitleTrackNotFound | SubtitleUnsupported | SubtitleConversionFailed
  >;
}

/** The subtitle converter. */
export class Service extends Context.Service<Service, Interface>()(
  "@movies/media/SubtitleConverter",
) {}

const CACHE_NAMESPACE = "subtitles";

const CACHE_MAX_AGE = Duration.days(3650);

const webVttArgs = (input: string, map: ReadonlyArray<string>): ReadonlyArray<string> => [
  "-hide_banner",
  "-nostdin",
  "-v",
  "error",
  "-i",
  input,
  ...map,
  "-c:s",
  "webvtt",
  "-f",
  "webvtt",
  "pipe:1",
];

/** Builds the converter. */
export const make = Effect.gen(function* () {
  const tools = yield* MediaTools.Service;
  const cache = yield* DiskCache.Service;
  const fs = yield* FileSystem.FileSystem;

  const toWebVtt = Effect.fn("SubtitleConverter.toWebVtt")(function* (
    file: ResolvedMediaFile,
    trackId: string,
  ) {
    const track = subtitleTracks(file).find((candidate) => candidate.id === trackId);

    if (track === undefined) return yield* new SubtitleTrackNotFound({ trackId });

    if (track.kind === "bitmap")
      return yield* new SubtitleUnsupported({ trackId, codec: track.codec });
    const key = `${file.fileId}:${file.sizeBytes}:${file.modifiedAtMs}:${trackId}`;
    const cached = yield* cache.read(CACHE_NAMESPACE, key, CACHE_MAX_AGE);

    if (Option.isSome(cached) && cached.value.startsWith("WEBVTT")) return cached.value;

    const sidecar =
      track.source === "sidecar" ? file.subtitles[Number(trackId.slice(1))] : undefined;

    const failed = (detail: string) => new SubtitleConversionFailed({ trackId, detail });

    if (sidecar?.format === "vtt") {
      const text = yield* fs
        .readFileString(sidecar.path)
        .pipe(Effect.mapError(() => failed("unreadable")));

      if (text.replace(/^﻿/, "").startsWith("WEBVTT")) return text.replace(/^﻿/, "");
    }

    const args =
      sidecar === undefined
        ? webVttArgs(file.path, ["-map", `0:${trackId.slice(1)}`])
        : webVttArgs(sidecar.path, ["-map", "0:s:0"]);

    const vtt = yield* tools
      .ffmpeg(args)
      .pipe(Effect.mapError((error) => failed(`ffmpeg exited with ${String(error.exitCode)}`)));

    yield* cache.write(CACHE_NAMESPACE, key, vtt);

    return vtt;
  });

  return Service.of({ toWebVtt });
});

/** The converter over ffmpeg and the disk cache. */
export const layer: Layer.Layer<
  Service,
  never,
  MediaTools.Service | DiskCache.Service | FileSystem.FileSystem
> = Layer.effect(Service, make);
