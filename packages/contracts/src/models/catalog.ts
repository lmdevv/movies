/** Libraries, titles, seasons, episodes, and media files with their probe information. */
import { Schema } from "effect";

import { AgeRating } from "../content-rating";
import { EpisodeId, LibraryId, MediaFileId, SeasonId, TitleId, UserId } from "../ids";
import { Bytes, EpochMillis, Milliseconds } from "../units";

/** What a library holds. `mixed` folders contain both movies and shows. */
export const LibraryKind = Schema.Literals(["movies", "shows", "mixed"]);

/** What a library holds. */
export type LibraryKind = typeof LibraryKind.Type;

/** `everyone` libraries are visible to every account; `restricted` ones only to granted members and admins. */
export const LibraryAccess = Schema.Literals(["everyone", "restricted"]);

/** Who sees a library. */
export type LibraryAccess = typeof LibraryAccess.Type;

/** An absolute folder path on the media host. */
export const LibraryRoot = Schema.String.check(Schema.isPattern(/^\//u), Schema.isMaxLength(1024));

/** A library as viewers see it. Folder paths are visible only to `manage` sessions. */
export const Library = Schema.Struct({
  id: LibraryId,
  name: Schema.String,
  kind: LibraryKind,
  titleCount: Schema.Int,
  lastScanAt: Schema.NullOr(EpochMillis),
  scanning: Schema.Boolean,
});

/** A library. */
export interface Library extends Schema.Schema.Type<typeof Library> {}

/** A library with its folders and access rules, for admins. */
export const LibraryDetail = Schema.Struct({
  ...Library.fields,
  roots: Schema.Array(Schema.String),
  access: LibraryAccess,
  /** Members granted a `restricted` library. Admins always see every library. */
  grantedUserIds: Schema.Array(UserId),
  createdAt: EpochMillis,
});

/** A library with its folders and access rules. */
export interface LibraryDetail extends Schema.Schema.Type<typeof LibraryDetail> {}

/** A movie or a show. */
export const TitleKind = Schema.Literals(["movie", "show"]);

/** A movie or a show. */
export type TitleKind = typeof TitleKind.Type;

/** How a title's metadata was matched. `manual` titles keep their match across rescans. */
export const MatchStatus = Schema.Literals(["matched", "unmatched", "manual"]);

/** How a title's metadata was matched. */
export type MatchStatus = typeof MatchStatus.Type;

/** Identifiers at metadata providers. */
export const ExternalIds = Schema.Struct({
  tmdb: Schema.NullOr(Schema.String),
  imdb: Schema.NullOr(Schema.String),
  tvdb: Schema.NullOr(Schema.String),
});

/** Identifiers at metadata providers. */
export interface ExternalIds extends Schema.Schema.Type<typeof ExternalIds> {}

/**
 * Artwork references. Each is an opaque key the media service resolves; clients load it from
 * `${mediaBaseUrl}/artwork/${key}`.
 */
export const Artwork = Schema.Struct({
  poster: Schema.NullOr(Schema.String),
  backdrop: Schema.NullOr(Schema.String),
  logo: Schema.NullOr(Schema.String),
});

/** Artwork references. */
export interface Artwork extends Schema.Schema.Type<typeof Artwork> {}

/** A title in a row or grid. */
export const TitleCard = Schema.Struct({
  id: TitleId,
  kind: TitleKind,
  name: Schema.String,
  year: Schema.NullOr(Schema.Int),
  certification: Schema.NullOr(Schema.String),
  ageRating: Schema.NullOr(AgeRating),
  runtimeMs: Schema.NullOr(Milliseconds),
  genres: Schema.Array(Schema.String),
  artwork: Artwork,
  /** At least one file is present on disk. */
  available: Schema.Boolean,
  addedAt: EpochMillis,
});

/** A title in a row or grid. */
export interface TitleCard extends Schema.Schema.Type<typeof TitleCard> {}

/** High dynamic range format of a video stream. */
export const HdrFormat = Schema.Literals(["none", "hdr10", "hdr10plus", "hlg", "dolby_vision"]);

/** High dynamic range format. */
export type HdrFormat = typeof HdrFormat.Type;

/** A video stream from ffprobe. */
export const VideoStream = Schema.Struct({
  index: Schema.Int,
  codec: Schema.String,
  profile: Schema.NullOr(Schema.String),
  width: Schema.Int,
  height: Schema.Int,
  frameRate: Schema.NullOr(Schema.Finite),
  bitDepth: Schema.NullOr(Schema.Int),
  pixelFormat: Schema.NullOr(Schema.String),
  hdr: HdrFormat,
  bitRate: Schema.NullOr(Schema.Int),
});

/** A video stream. */
export interface VideoStream extends Schema.Schema.Type<typeof VideoStream> {}

/** An audio stream from ffprobe. */
export const AudioStream = Schema.Struct({
  index: Schema.Int,
  codec: Schema.String,
  profile: Schema.NullOr(Schema.String),
  channels: Schema.Int,
  channelLayout: Schema.NullOr(Schema.String),
  language: Schema.NullOr(Schema.String),
  title: Schema.NullOr(Schema.String),
  default: Schema.Boolean,
  bitRate: Schema.NullOr(Schema.Int),
});

/** An audio stream. */
export interface AudioStream extends Schema.Schema.Type<typeof AudioStream> {}

/** `text` subtitles convert to WebVTT; `image` subtitles (PGS, VobSub) need burn-in. */
export const SubtitleKind = Schema.Literals(["text", "image"]);

/** A subtitle stream embedded in the container, from ffprobe. */
export const SubtitleStream = Schema.Struct({
  index: Schema.Int,
  codec: Schema.String,
  kind: SubtitleKind,
  language: Schema.NullOr(Schema.String),
  title: Schema.NullOr(Schema.String),
  default: Schema.Boolean,
  forced: Schema.Boolean,
});

/** An embedded subtitle stream. */
export interface SubtitleStream extends Schema.Schema.Type<typeof SubtitleStream> {}

/** What ffprobe reported about a file. */
export const Probe = Schema.Struct({
  container: Schema.String,
  durationMs: Milliseconds,
  bitRate: Schema.NullOr(Schema.Int),
  video: Schema.Array(VideoStream),
  audio: Schema.Array(AudioStream),
  subtitles: Schema.Array(SubtitleStream),
});

/** What ffprobe reported about a file. */
export interface Probe extends Schema.Schema.Type<typeof Probe> {}

/** A sidecar subtitle file next to the media file, such as `Movie.en.srt`. */
export const ExternalSubtitle = Schema.Struct({
  /** Path relative to the media file's folder. */
  fileName: Schema.String,
  codec: Schema.String,
  language: Schema.NullOr(Schema.String),
  forced: Schema.Boolean,
});

/** A sidecar subtitle file. */
export interface ExternalSubtitle extends Schema.Schema.Type<typeof ExternalSubtitle> {}

/** A playable file as viewers see it. Paths stay private to the media service and admins. */
export const MediaFile = Schema.Struct({
  id: MediaFileId,
  titleId: TitleId,
  episodeId: Schema.NullOr(EpisodeId),
  /** A version label such as `Director's Cut` or `4K`, when a title has several files. */
  versionName: Schema.NullOr(Schema.String),
  sizeBytes: Bytes,
  probe: Probe,
  externalSubtitles: Schema.Array(ExternalSubtitle),
  /** The primary video stream is HDR. */
  hdr: Schema.Boolean,
  /** The file is no longer on disk. History that points at it stays. */
  missing: Schema.Boolean,
});

/** A playable file. */
export interface MediaFile extends Schema.Schema.Type<typeof MediaFile> {}

/** A profile's progress through a movie or an episode. */
export const Progress = Schema.Struct({
  positionMs: Milliseconds,
  durationMs: Milliseconds,
  watched: Schema.Boolean,
  updatedAt: EpochMillis,
});

/** Progress through a movie or an episode. */
export interface Progress extends Schema.Schema.Type<typeof Progress> {}

/** An episode in a list. */
export const Episode = Schema.Struct({
  id: EpisodeId,
  titleId: TitleId,
  seasonId: SeasonId,
  seasonNumber: Schema.Int,
  episodeNumber: Schema.Int,
  name: Schema.String,
  overview: Schema.NullOr(Schema.String),
  airDate: Schema.NullOr(Schema.String),
  runtimeMs: Schema.NullOr(Milliseconds),
  still: Schema.NullOr(Schema.String),
  available: Schema.Boolean,
  progress: Schema.NullOr(Progress),
});

/** An episode. */
export interface Episode extends Schema.Schema.Type<typeof Episode> {}

/** A season in a show's detail page. */
export const Season = Schema.Struct({
  id: SeasonId,
  seasonNumber: Schema.Int,
  name: Schema.String,
  poster: Schema.NullOr(Schema.String),
  episodeCount: Schema.Int,
});

/** A season. */
export interface Season extends Schema.Schema.Type<typeof Season> {}

/** Everything a title's detail page shows. */
export const TitleDetail = Schema.Struct({
  ...TitleCard.fields,
  libraryId: LibraryId,
  sortName: Schema.String,
  overview: Schema.NullOr(Schema.String),
  tagline: Schema.NullOr(Schema.String),
  externalIds: ExternalIds,
  matchStatus: MatchStatus,
  seasons: Schema.Array(Season),
  /** A movie's versions; empty for shows, whose files belong to episodes. */
  files: Schema.Array(MediaFile),
  /** A movie's progress; null for shows and unstarted movies. */
  progress: Schema.NullOr(Progress),
  /** For shows: the episode to resume or start next. */
  nextEpisode: Schema.NullOr(Episode),
  inMyList: Schema.Boolean,
});

/** Everything a title's detail page shows. */
export interface TitleDetail extends Schema.Schema.Type<typeof TitleDetail> {}

/** A row in continue watching: resume a started item, or start the next episode of a show. */
export const ContinueWatchingItem = Schema.Struct({
  reason: Schema.Literals(["resume", "next"]),
  title: TitleCard,
  episode: Schema.NullOr(Episode),
  progress: Schema.NullOr(Progress),
});

/** A row in continue watching. */
export interface ContinueWatchingItem extends Schema.Schema.Type<typeof ContinueWatchingItem> {}

/** The home screen's rows for one profile. */
export const Home = Schema.Struct({
  featured: Schema.NullOr(TitleCard),
  continueWatching: Schema.Array(ContinueWatchingItem),
  myList: Schema.Array(TitleCard),
  recentlyAddedMovies: Schema.Array(TitleCard),
  recentlyAddedShows: Schema.Array(TitleCard),
});

/** The home screen's rows. */
export interface Home extends Schema.Schema.Type<typeof Home> {}

/** One entry in a profile's watch history. */
export const HistoryEntry = Schema.Struct({
  title: TitleCard,
  episode: Schema.NullOr(Episode),
  progress: Progress,
  lastPlayedAt: EpochMillis,
});

/** One entry in watch history. */
export interface HistoryEntry extends Schema.Schema.Type<typeof HistoryEntry> {}

/** Sort orders for title lists. */
export const TitleSort = Schema.Literals(["name", "added", "year"]);

/** Sort orders for title lists. */
export type TitleSort = typeof TitleSort.Type;

/** Metadata fields an admin can override by hand. Scans never overwrite an override. */
export const MetadataOverrides = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  sortName: Schema.optionalKey(Schema.String),
  year: Schema.optionalKey(Schema.Int),
  overview: Schema.optionalKey(Schema.String),
  certification: Schema.optionalKey(Schema.String),
  ageRating: Schema.optionalKey(AgeRating),
});

/** Metadata fields an admin overrides. */
export interface MetadataOverrides extends Schema.Schema.Type<typeof MetadataOverrides> {}

/** Fields an admin can override, by name, for clearing overrides. */
export const MetadataField = Schema.Literals([
  "name",
  "sortName",
  "year",
  "overview",
  "certification",
  "ageRating",
]);

/** A possible metadata match offered when fixing a title's match. */
export const MetadataCandidate = Schema.Struct({
  provider: Schema.Literal("tmdb"),
  providerId: Schema.String,
  kind: TitleKind,
  name: Schema.String,
  year: Schema.NullOr(Schema.Int),
  overview: Schema.NullOr(Schema.String),
  /** A poster URL at the provider, for the match picker. */
  posterUrl: Schema.NullOr(Schema.String),
});

/** A possible metadata match. */
export interface MetadataCandidate extends Schema.Schema.Type<typeof MetadataCandidate> {}

/** Which files a library's admin file list shows. */
export const LibraryFileFilter = Schema.Literals(["all", "missing", "unmatched"]);

/** Which files a library's admin file list shows. */
export type LibraryFileFilter = typeof LibraryFileFilter.Type;

/** A file in a library's admin file list with the title it belongs to. Paths are for admins. */
export const LibraryFile = Schema.Struct({
  id: MediaFileId,
  /** The absolute path on the media host. */
  path: Schema.String,
  sizeBytes: Bytes,
  durationMs: Milliseconds,
  /** The primary video stream; null for a file without one. */
  video: Schema.NullOr(
    Schema.Struct({ codec: Schema.String, width: Schema.Int, height: Schema.Int, hdr: HdrFormat }),
  ),
  missing: Schema.Boolean,
  /** When a scan last found the file gone; null while it is present. */
  missingSince: Schema.NullOr(EpochMillis),
  title: Schema.Struct({
    id: TitleId,
    kind: TitleKind,
    name: Schema.String,
    year: Schema.NullOr(Schema.Int),
    matchStatus: MatchStatus,
    externalIds: ExternalIds,
    poster: Schema.NullOr(Schema.String),
  }),
  /** For a show's file, its season and episode numbers. */
  episode: Schema.NullOr(Schema.Struct({ seasonNumber: Schema.Int, episodeNumber: Schema.Int })),
});

/** A file in a library's admin file list. */
export interface LibraryFile extends Schema.Schema.Type<typeof LibraryFile> {}

/** What needs attention in a library: missing files and unmatched titles. */
export const LibraryFileSummary = Schema.Struct({
  missingFiles: Schema.Int,
  /** The earliest time a missing file went missing; null when none are missing. */
  missingSince: Schema.NullOr(EpochMillis),
  unmatchedTitles: Schema.Int,
});

/** What needs attention in a library. */
export interface LibraryFileSummary extends Schema.Schema.Type<typeof LibraryFileSummary> {}
