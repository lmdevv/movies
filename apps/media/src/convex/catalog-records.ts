/**
 * Translation between the scanner's records and the catalog records Convex stores
 * (`@movies/contracts/models/scan` and `models/catalog`). Convex keeps absolute paths, a probe
 * listing every video stream, and artwork keys; the scanner works with paths relative to a
 * library folder, one main video stream, and image references. Pure apart from sealing artwork
 * keys, which the caller supplies.
 */
import type { ArtworkKey } from "@movies/contracts/artwork";
import { ageRatingFromCertification } from "@movies/contracts/content-rating";
import { Container, type DynamicRange } from "@movies/contracts/media-playback";
import type { ExternalSubtitle, HdrFormat, Probe } from "@movies/contracts/models/catalog";
import type {
  ResolvedFile,
  ScannedEpisode,
  ScannedItem,
  ScannedTitle,
} from "@movies/contracts/models/scan";
import { Bytes, EpochMillis, Milliseconds } from "@movies/contracts/units";
import { Effect, Option, Schema } from "effect";

import { ArtworkSource } from "../artwork/artwork-keys.ts";
import type { LibraryFolder, ScannedFile } from "../library/library-sink.ts";
import { SidecarFormat } from "../library/sidecar-subtitles.ts";
import { MediaName } from "../library/media-naming.ts";
import type { MediaProbe } from "../media/media-probe.ts";
import { type EpisodeMetadata, ImageRef, type TitleMetadata } from "../metadata/title-metadata.ts";
import type { ResolvedMediaFile } from "../playback/file-resolver.ts";

/** Seals an artwork source into the key titles carry. */
type SealArtwork = (source: ArtworkSource) => Effect.Effect<ArtworkKey>;

const HDR_FORMATS: Readonly<Record<DynamicRange, HdrFormat>> = {
  sdr: "none",
  hdr10: "hdr10",
  hlg: "hlg",
  "dolby-vision": "dolby_vision",
};

const DYNAMIC_RANGES: Readonly<Record<HdrFormat, DynamicRange>> = {
  none: "sdr",
  hdr10: "hdr10",
  hdr10plus: "hdr10",
  hlg: "hlg",
  dolby_vision: "dolby-vision",
};

/** An optional field's value, for spreading it only when present. */
const present = <A>(value: A | undefined): Option.Option<A> => Option.fromUndefinedOr(value);

/** The absolute path of `relativePath` inside a library folder. */
export const absolutePath = (folder: LibraryFolder, relativePath: string): string =>
  `${folder.root.replace(/\/+$/u, "")}/${relativePath}`;

/** The path relative to `root` when `path` lies inside it. */
export const relativeTo = (root: string, path: string): Option.Option<string> => {
  const prefix = `${root.replace(/\/+$/u, "")}/`;

  return path.startsWith(prefix) ? Option.some(path.slice(prefix.length)) : Option.none();
};

const fileNameOf = (path: string): string => path.split("/").at(-1) ?? path;

const folderOf = (path: string): string => path.split("/").slice(0, -1).join("/");

/** The catalog probe of a scanned file. */
export const toCatalogProbe = (probe: MediaProbe): Probe => ({
  container: probe.container,
  formatName: probe.formatName,
  durationMs: Milliseconds.make(Math.round(probe.durationSeconds * 1000)),
  startMs: Math.round(probe.startSeconds * 1000),
  bitRate: probe.bitRate ?? null,
  video:
    probe.video === undefined
      ? []
      : [
          {
            index: probe.video.index,
            codec: probe.video.codec,
            profile: probe.video.profile ?? null,
            ...Option.match(present(probe.video.level), {
              onNone: () => ({}),
              onSome: (level) => ({ level }),
            }),
            width: probe.video.width,
            height: probe.video.height,
            frameRate: probe.video.frameRate ?? null,
            bitDepth: probe.video.bitDepth,
            pixelFormat: probe.video.pixelFormat ?? null,
            hdr: HDR_FORMATS[probe.video.dynamicRange],
            bitRate: null,
          },
        ],
  audio: probe.audio.map((track) => ({
    index: track.index,
    codec: track.codec,
    profile: track.profile ?? null,
    channels: track.channels,
    channelLayout: track.channelLayout ?? null,
    ...Option.match(present(track.sampleRate), {
      onNone: () => ({}),
      onSome: (sampleRate) => ({ sampleRate }),
    }),
    language: track.language ?? null,
    title: track.title ?? null,
    default: track.default,
    bitRate: null,
  })),
  subtitles: probe.subtitles.map((subtitle) => ({
    index: subtitle.index,
    codec: subtitle.codec,
    kind: subtitle.kind === "bitmap" ? ("image" as const) : ("text" as const),
    language: subtitle.language ?? null,
    title: subtitle.title ?? null,
    default: subtitle.default,
    forced: subtitle.forced,
    hearingImpaired: subtitle.hearingImpaired,
  })),
});

const decodeContainer = Schema.decodeUnknownOption(Container);

const decodeSidecarFormat = Schema.decodeUnknownOption(SidecarFormat);

/** The playback probe of a catalog file. Records written before probes kept every field use defaults. */
const toMediaProbe = (probe: Probe): MediaProbe => {
  const [video] = probe.video;

  return {
    container: Option.getOrElse(decodeContainer(probe.container), () => "other" as const),
    formatName: probe.formatName ?? probe.container,
    durationSeconds: probe.durationMs / 1000,
    startSeconds: (probe.startMs ?? 0) / 1000,
    bitRate: probe.bitRate ?? undefined,
    video:
      video === undefined
        ? undefined
        : {
            index: video.index,
            codec: video.codec,
            profile: video.profile ?? undefined,
            level: video.level,
            pixelFormat: video.pixelFormat ?? undefined,
            bitDepth: video.bitDepth ?? 8,
            width: video.width,
            height: video.height,
            frameRate: video.frameRate ?? undefined,
            dynamicRange: DYNAMIC_RANGES[video.hdr],
          },
    audio: probe.audio.map((track) => ({
      index: track.index,
      codec: track.codec,
      profile: track.profile ?? undefined,
      channels: track.channels,
      channelLayout: track.channelLayout ?? undefined,
      sampleRate: track.sampleRate,
      language: track.language ?? undefined,
      title: track.title ?? undefined,
      default: track.default,
    })),
    subtitles: probe.subtitles.map((subtitle) => ({
      index: subtitle.index,
      codec: subtitle.codec,
      kind: subtitle.kind === "image" ? ("bitmap" as const) : ("text" as const),
      language: subtitle.language ?? undefined,
      title: subtitle.title ?? undefined,
      default: subtitle.default,
      forced: subtitle.forced,
      hearingImpaired: subtitle.hearingImpaired ?? false,
    })),
  };
};

/** Everything playback needs about a catalog file. Sidecars of unknown formats are dropped. */
export const toResolvedMediaFile = (
  resolved: ResolvedFile,
  sizeBytes: number,
  modifiedAtMs: number,
): ResolvedMediaFile => {
  const folder = folderOf(resolved.path);

  return {
    fileId: resolved.fileId,
    path: resolved.path,
    sizeBytes,
    modifiedAtMs,
    probe: toMediaProbe(resolved.probe),
    subtitles: resolved.externalSubtitles.flatMap((subtitle) =>
      Option.match(decodeSidecarFormat(subtitle.codec), {
        onNone: () => [],
        onSome: (format) => [
          {
            path: `${folder}/${subtitle.fileName}`,
            format,
            language: subtitle.language ?? undefined,
            title: subtitle.title,
            forced: subtitle.forced,
            hearingImpaired: subtitle.hearingImpaired ?? false,
            default: subtitle.default ?? false,
          },
        ],
      }),
    ),
  };
};

const normaliseName = (name: string): string =>
  name.toLowerCase().replaceAll(/\s+/gu, " ").trim().slice(0, 200);

/**
 * The key that identifies a title within its library across scans: the kind plus a provider ID
 * when one is known (TMDB IDs of movies and shows overlap), otherwise the name and year.
 */
export const matchKeyOf = (metadata: TitleMetadata): string => {
  const { ids } = metadata;

  if (ids.tmdb !== undefined) return `${metadata.kind}:tmdb:${ids.tmdb}`;

  if (ids.imdb !== undefined) return `${metadata.kind}:imdb:${ids.imdb}`;

  if (ids.tvdb !== undefined) return `${metadata.kind}:tvdb:${ids.tvdb}`;

  const year = metadata.year === undefined ? "" : ` (${String(metadata.year)})`;

  return `${metadata.kind}:local:${normaliseName(metadata.title)}${year}`;
};

/** The artwork key of an image reference; local paths are relative to `folder`. */
const artworkKey = (
  folder: LibraryFolder,
  image: ImageRef | undefined,
  seal: SealArtwork,
): Effect.Effect<ArtworkKey | null> =>
  image === undefined
    ? Effect.succeed(null)
    : seal(
        ImageRef.match(image, {
          Local: ({ path }): ArtworkSource =>
            ArtworkSource.Local({ path: absolutePath(folder, path) }),
          Remote: ({ url }): ArtworkSource => ArtworkSource.Remote({ url }),
        }),
      );

/** The catalog title of merged title metadata. */
export const toScannedTitle = Effect.fnUntraced(function* (
  folder: LibraryFolder,
  metadata: TitleMetadata,
  seal: SealArtwork,
) {
  const certification = metadata.contentRating ?? null;
  const hasIds = Object.values(metadata.ids).some((id) => id !== undefined);

  return {
    kind: metadata.kind,
    matchKey: matchKeyOf(metadata),
    name: metadata.title,
    sortName: metadata.sortTitle ?? null,
    year: metadata.year ?? null,
    overview: metadata.plot ?? null,
    tagline: metadata.tagline ?? null,
    genres: metadata.genres,
    certification,
    ageRating: certification === null ? null : (ageRatingFromCertification(certification) ?? null),
    runtimeMs:
      metadata.runtimeMinutes === undefined
        ? null
        : Milliseconds.make(metadata.runtimeMinutes * 60_000),
    artwork: {
      poster: yield* artworkKey(folder, metadata.poster, seal),
      backdrop: yield* artworkKey(folder, metadata.backdrop, seal),
      logo: yield* artworkKey(folder, metadata.logo, seal),
    },
    externalIds: {
      tmdb: metadata.ids.tmdb ?? null,
      imdb: metadata.ids.imdb ?? null,
      tvdb: metadata.ids.tvdb ?? null,
    },
    matchStatus: metadata.sources.includes("provider") || hasIds ? "matched" : "unmatched",
  } satisfies ScannedTitle;
});

/** The catalog episode of merged episode metadata. A multi-episode file maps to its first. */
export const toScannedEpisode = Effect.fnUntraced(function* (
  folder: LibraryFolder,
  metadata: EpisodeMetadata,
  seal: SealArtwork,
) {
  return {
    seasonNumber: metadata.season,
    episodeNumber: metadata.episodes[0],
    name: metadata.title ?? null,
    overview: metadata.plot ?? null,
    airDate: metadata.airDate ?? null,
    runtimeMs:
      metadata.runtimeMinutes === undefined
        ? null
        : Milliseconds.make(metadata.runtimeMinutes * 60_000),
    still: yield* artworkKey(folder, metadata.still, seal),
    seasonName: null,
    seasonPoster: yield* artworkKey(folder, metadata.seasonPoster, seal),
  } satisfies ScannedEpisode;
});

const toExternalSubtitle = (subtitle: ScannedFile["subtitles"][number]): ExternalSubtitle => ({
  fileName: fileNameOf(subtitle.path),
  codec: subtitle.format,
  language: subtitle.language ?? null,
  ...Option.match(present(subtitle.title), {
    onNone: () => ({}),
    onSome: (title) => ({ title }),
  }),
  forced: subtitle.forced,
  hearingImpaired: subtitle.hearingImpaired,
  default: subtitle.default,
});

/**
 * The catalog item of a scanned file, or none for an extra (a trailer or featurette), which
 * belongs to no title.
 */
export const toScannedItem = Effect.fnUntraced(function* (
  folder: LibraryFolder,
  file: ScannedFile,
  seal: SealArtwork,
) {
  if (file.title === undefined) return Option.none<ScannedItem>();

  const item: ScannedItem = {
    file: {
      path: absolutePath(folder, file.relativePath),
      sizeBytes: Bytes.make(file.sizeBytes),
      mtimeMs: EpochMillis.make(Math.trunc(file.modifiedAtMs)),
      probe: toCatalogProbe(file.probe),
      externalSubtitles: file.subtitles.map(toExternalSubtitle),
      versionName: MediaName.guards.Movie(file.name) ? (file.name.edition ?? null) : null,
    },
    title: yield* toScannedTitle(folder, file.title, seal),
    episode:
      file.episode === undefined ? null : yield* toScannedEpisode(folder, file.episode, seal),
  };

  return Option.some(item);
});
