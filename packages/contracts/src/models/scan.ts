/** What the media service reports to Convex while scanning folders and importing history. */
import { Schema } from "effect";

import { AgeRating } from "../content-rating";
import {
  EpisodeId,
  JobId,
  LibraryId,
  MediaFileId,
  PlaybackSessionId,
  ProfileId,
  TitleId,
  UserId,
} from "../ids";
import { Bytes, EpochMillis, Milliseconds } from "../units";
import {
  Artwork,
  ExternalIds,
  ExternalSubtitle,
  LibraryKind,
  MetadataOverrides,
  Probe,
  TitleKind,
} from "./catalog";
import { Job, MigrationSource } from "./jobs";

/** Most items one scan or import write may carry. */
export const SCAN_BATCH_LIMIT = 100;

/** A library as the media service needs it: the folders it may read. */
export const MediaLibrary = Schema.Struct({
  id: LibraryId,
  name: Schema.String,
  kind: LibraryKind,
  roots: Schema.Array(Schema.String),
});

/** A library's folders. */
export interface MediaLibrary extends Schema.Schema.Type<typeof MediaLibrary> {}

/** A job the worker now holds, with its library when it has one. */
export const ClaimedJob = Schema.Struct({
  job: Job,
  library: Schema.NullOr(MediaLibrary),
  leaseExpiresAt: EpochMillis,
});

/** A claimed job. */
export interface ClaimedJob extends Schema.Schema.Type<typeof ClaimedJob> {}

/** Arguments that identify the worker holding a job's lease. */
export const LeaseArgs = {
  jobId: JobId,
  workerId: Schema.Trimmed.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
};

/** How long a claim or renewal holds the lease: 5 seconds to 10 minutes. */
export const LeaseMs = Schema.Int.check(Schema.isBetween({ minimum: 5_000, maximum: 600_000 }));

/**
 * A title as the scanner identified and matched it. `matchKey` identifies the title within its
 * library across scans, such as `tmdb:603` or `local:the matrix (1999)`.
 */
export const ScannedTitle = Schema.Struct({
  kind: TitleKind,
  matchKey: Schema.Trimmed.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
  name: Schema.String,
  sortName: Schema.NullOr(Schema.String),
  year: Schema.NullOr(Schema.Int),
  overview: Schema.NullOr(Schema.String),
  tagline: Schema.NullOr(Schema.String),
  genres: Schema.Array(Schema.String),
  certification: Schema.NullOr(Schema.String),
  ageRating: Schema.NullOr(AgeRating),
  runtimeMs: Schema.NullOr(Milliseconds),
  artwork: Artwork,
  externalIds: ExternalIds,
  matchStatus: Schema.Literals(["matched", "unmatched"]),
});

/** A scanned title. */
export interface ScannedTitle extends Schema.Schema.Type<typeof ScannedTitle> {}

/** An episode as the scanner identified it, with its season's details. */
export const ScannedEpisode = Schema.Struct({
  seasonNumber: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  episodeNumber: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  name: Schema.NullOr(Schema.String),
  overview: Schema.NullOr(Schema.String),
  airDate: Schema.NullOr(Schema.String),
  runtimeMs: Schema.NullOr(Milliseconds),
  still: Schema.NullOr(Schema.String),
  seasonName: Schema.NullOr(Schema.String),
  seasonPoster: Schema.NullOr(Schema.String),
});

/** A scanned episode. */
export interface ScannedEpisode extends Schema.Schema.Type<typeof ScannedEpisode> {}

/** A file as the scanner found and probed it. `path` is absolute and inside a library root. */
export const ScannedFile = Schema.Struct({
  path: Schema.String,
  sizeBytes: Bytes,
  mtimeMs: EpochMillis,
  probe: Probe,
  externalSubtitles: Schema.Array(ExternalSubtitle),
  versionName: Schema.NullOr(Schema.String),
});

/** A scanned file. */
export interface ScannedFile extends Schema.Schema.Type<typeof ScannedFile> {}

/** One scanned file with the title (and episode, for shows) it belongs to. */
export const ScannedItem = Schema.Struct({
  file: ScannedFile,
  title: ScannedTitle,
  episode: Schema.NullOr(ScannedEpisode),
});

/** One scanned file with its title. */
export interface ScannedItem extends Schema.Schema.Type<typeof ScannedItem> {}

/** Where each upserted file landed. */
export const UpsertedFile = Schema.Struct({
  path: Schema.String,
  fileId: MediaFileId,
  titleId: TitleId,
  episodeId: Schema.NullOr(EpisodeId),
});

/** A known file, for skipping unchanged files and detecting missing ones. */
export const IndexedFile = Schema.Struct({
  path: Schema.String,
  sizeBytes: Bytes,
  mtimeMs: EpochMillis,
  missing: Schema.Boolean,
});

/** Everything the media service needs to serve a file named in a playback token. */
export const ResolvedFile = Schema.Struct({
  fileId: MediaFileId,
  libraryId: LibraryId,
  path: Schema.String,
  /** The library's folders; the media service refuses paths that resolve outside them. */
  roots: Schema.Array(Schema.String),
  probe: Probe,
  externalSubtitles: Schema.Array(ExternalSubtitle),
  missing: Schema.Boolean,
});

/** A file named in a playback token. */
export interface ResolvedFile extends Schema.Schema.Type<typeof ResolvedFile> {}

/** A playback session's state, for checking a token's `sid` is still active. */
export const SessionStatus = Schema.Struct({
  sessionId: PlaybackSessionId,
  status: Schema.Literals(["active", "ended"]),
  fileId: MediaFileId,
  endedAt: Schema.NullOr(EpochMillis),
});

/** An ended playback session whose streams the media service should stop. */
export const EndedSession = Schema.Struct({
  sessionId: PlaybackSessionId,
  endedAt: EpochMillis,
});

/** A title for a metadata job: what to look up and which episodes exist. */
export const MetadataTarget = Schema.Struct({
  titleId: TitleId,
  libraryId: LibraryId,
  kind: TitleKind,
  name: Schema.String,
  year: Schema.NullOr(Schema.Int),
  externalIds: ExternalIds,
  /** The title's current artwork, kept where the provider has none. */
  artwork: Artwork,
  episodes: Schema.Array(Schema.Struct({ seasonNumber: Schema.Int, episodeNumber: Schema.Int })),
});

/** A [movies] account and its profiles, for mapping migration source users. */
export const MigrationTarget = Schema.Struct({
  userId: UserId,
  name: Schema.String,
  email: Schema.NullOr(Schema.String),
  profiles: Schema.Array(Schema.Struct({ profileId: ProfileId, name: Schema.String })),
});

/** One item's watch state from a migration source, matched to a file by path. */
export const ImportedWatchState = Schema.Struct({
  profileId: ProfileId,
  path: Schema.String,
  watched: Schema.Boolean,
  positionMs: Milliseconds,
  lastPlayedAt: Schema.NullOr(EpochMillis),
  favorite: Schema.Boolean,
});

/** One title's metadata overrides from a migration source, matched by a file path. */
export const ImportedOverride = Schema.Struct({
  path: Schema.String,
  overrides: MetadataOverrides,
});

/** How many imported items matched a [movies] file. */
export const ImportCounts = Schema.Struct({ matched: Schema.Int, unmatched: Schema.Int });

/** Arguments to start a migration job for an admin the media service verified. */
export const StartMigrationArgs = Schema.Struct({
  requestedBy: UserId,
  source: MigrationSource,
  connectionId: Schema.String,
  serverName: Schema.String,
});
