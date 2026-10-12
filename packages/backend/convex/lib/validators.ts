/**
 * Convex validators for every command's arguments and results. Each mirrors a schema in
 * `@movies/contracts`; `test/registry.test.ts` checks that they describe the same wire values.
 */
import { v } from "convex/values";
import type { Validator } from "convex/values";

/** `T | null`, the wire form of a field that may be empty. */
export const nullable = <T, FieldPaths extends string>(
  validator: Validator<T, "required", FieldPaths>,
) => v.union(validator, v.null());

/** Mirrors `Ok` in `@movies/contracts/models/common`. */
export const ok = v.object({ ok: v.literal(true) });

/** Paging arguments; mirrors `PageArgs` in `@movies/contracts/models/common`. */
export const pageArgs = {
  cursor: v.optional(nullable(v.string())),
  limit: v.optional(v.number()),
};

/** A page of `item`; `nextCursor` is null on the last page. */
export const page = <T, FieldPaths extends string>(item: Validator<T, "required", FieldPaths>) =>
  v.object({ items: v.array(item), nextCursor: nullable(v.string()) });

// Accounts and sessions.

/** Mirrors `Role` in `@movies/contracts`. */
export const role = v.union(
  v.literal("owner"),
  v.literal("admin"),
  v.literal("member"),
  v.literal("service"),
);

/** Mirrors `AssignableRole` in `@movies/contracts`. */
export const assignableRole = v.union(v.literal("admin"), v.literal("member"));

/** Mirrors `Scope` in `@movies/contracts`. */
export const scope = v.union(
  v.literal("read"),
  v.literal("play"),
  v.literal("account"),
  v.literal("manage"),
  v.literal("admin"),
  v.literal("media-service"),
);

/** Mirrors `ApiKeyScope` in `@movies/contracts`. */
export const apiKeyScope = v.union(
  v.literal("read"),
  v.literal("play"),
  v.literal("manage"),
  v.literal("admin"),
);

/** Mirrors `DeviceScope` in `@movies/contracts`. */
export const deviceScope = v.union(
  v.literal("read"),
  v.literal("play"),
  v.literal("account"),
  v.literal("manage"),
  v.literal("admin"),
);

/** Mirrors `SessionKind` in `@movies/contracts`. */
export const sessionKind = v.union(v.literal("password"), v.literal("apikey"), v.literal("device"));

/** Mirrors `User` in `@movies/contracts`. */
export const user = v.object({
  id: v.id("users"),
  email: nullable(v.string()),
  name: v.string(),
  role,
  disabled: v.boolean(),
  createdAt: v.number(),
});

/** Mirrors `Viewer` in `@movies/contracts`. */
export const viewer = v.object({
  user,
  sessionId: v.id("authSessions"),
  sessionKind,
  scopes: v.array(scope),
});

/** Mirrors `SessionInfo` in `@movies/contracts`. */
export const sessionInfo = v.object({
  id: v.id("authSessions"),
  kind: sessionKind,
  label: nullable(v.string()),
  scopes: v.array(scope),
  createdAt: v.number(),
  expiresAt: v.number(),
  current: v.boolean(),
});

/** Mirrors `SetupStatus` in `@movies/contracts`. */
export const setupStatus = v.object({ hasOwner: v.boolean(), hasLibraries: v.boolean() });

/** Mirrors `InviteState` in `@movies/contracts`. */
export const inviteState = v.union(
  v.literal("open"),
  v.literal("used"),
  v.literal("expired"),
  v.literal("revoked"),
);

/** Mirrors `Invite` in `@movies/contracts`. */
export const invite = v.object({
  id: v.id("invites"),
  email: nullable(v.string()),
  role: assignableRole,
  state: inviteState,
  createdBy: v.id("users"),
  createdAt: v.number(),
  expiresAt: v.number(),
});

/** Mirrors `CreatedInvite` in `@movies/contracts`. */
export const createdInvite = v.object({ invite, code: v.string(), url: v.string() });

/** Mirrors `InviteLookup` in `@movies/contracts`. */
export const inviteLookup = v.union(
  v.object({ state: v.literal("invalid") }),
  v.object({
    state: v.union(v.literal("open"), v.literal("used"), v.literal("expired")),
    email: nullable(v.string()),
    inviterName: v.string(),
    expiresAt: v.number(),
  }),
);

/** Mirrors `ApiKey` in `@movies/contracts`. */
export const apiKey = v.object({
  id: v.id("apiKeys"),
  userId: v.id("users"),
  name: v.string(),
  prefix: v.string(),
  scopes: v.array(apiKeyScope),
  createdAt: v.number(),
  lastUsedAt: nullable(v.number()),
  expiresAt: nullable(v.number()),
  revokedAt: nullable(v.number()),
});

/** Mirrors `CreatedApiKey` in `@movies/contracts`. */
export const createdApiKey = v.object({ apiKey, secret: v.string() });

/** Mirrors `DeviceCodeRequest` in `@movies/contracts`. */
export const deviceCodeRequest = v.object({
  deviceCode: v.string(),
  userCode: v.string(),
  verificationUrl: v.string(),
  expiresAt: v.number(),
});

/** Mirrors `DeviceCodeState` in `@movies/contracts`. */
export const deviceCodeState = v.union(
  v.literal("pending"),
  v.literal("approved"),
  v.literal("denied"),
  v.literal("expired"),
  v.literal("consumed"),
);

/** Mirrors `DeviceCodeLookup` in `@movies/contracts`. */
export const deviceCodeLookup = v.object({
  userCode: v.string(),
  clientName: v.string(),
  state: deviceCodeState,
  requestedAt: v.number(),
  expiresAt: v.number(),
});

// Profiles.

/** Mirrors `Profile` in `@movies/contracts`. */
export const profile = v.object({
  id: v.id("profiles"),
  name: v.string(),
  avatar: v.string(),
  kids: v.boolean(),
  maxAgeRating: nullable(v.number()),
  hasPin: v.boolean(),
  locked: v.boolean(),
  createdAt: v.number(),
});

/** Mirrors `UnlockResult` in `@movies/contracts`. */
export const unlockResult = v.union(
  v.object({ status: v.literal("unlocked") }),
  v.object({ status: v.literal("wrong_pin"), attemptsLeft: v.number() }),
  v.object({ status: v.literal("locked_out"), retryAt: v.number() }),
);

// Catalog.

/** Mirrors `LibraryKind` in `@movies/contracts`. */
export const libraryKind = v.union(v.literal("movies"), v.literal("shows"), v.literal("mixed"));

/** Mirrors `LibraryAccess` in `@movies/contracts`. */
export const libraryAccess = v.union(v.literal("everyone"), v.literal("restricted"));

const libraryFields = {
  id: v.id("libraries"),
  name: v.string(),
  kind: libraryKind,
  titleCount: v.number(),
  lastScanAt: nullable(v.number()),
  scanning: v.boolean(),
};

/** Mirrors `Library` in `@movies/contracts`. */
export const library = v.object(libraryFields);

/** Mirrors `LibraryDetail` in `@movies/contracts`. */
export const libraryDetail = v.object({
  ...libraryFields,
  roots: v.array(v.string()),
  access: libraryAccess,
  grantedUserIds: v.array(v.id("users")),
  createdAt: v.number(),
});

/** Mirrors `TitleKind` in `@movies/contracts`. */
export const titleKind = v.union(v.literal("movie"), v.literal("show"));

/** Mirrors `MatchStatus` in `@movies/contracts`. */
export const matchStatus = v.union(
  v.literal("matched"),
  v.literal("unmatched"),
  v.literal("manual"),
);

/** Mirrors `ExternalIds` in `@movies/contracts`. */
export const externalIds = v.object({
  tmdb: nullable(v.string()),
  imdb: nullable(v.string()),
  tvdb: nullable(v.string()),
});

/** Mirrors `Artwork` in `@movies/contracts`. */
export const artwork = v.object({
  poster: nullable(v.string()),
  backdrop: nullable(v.string()),
  logo: nullable(v.string()),
});

const titleCardFields = {
  id: v.id("titles"),
  kind: titleKind,
  name: v.string(),
  year: nullable(v.number()),
  certification: nullable(v.string()),
  ageRating: nullable(v.number()),
  runtimeMs: nullable(v.number()),
  genres: v.array(v.string()),
  artwork,
  available: v.boolean(),
  addedAt: v.number(),
};

/** Mirrors `TitleCard` in `@movies/contracts`. */
export const titleCard = v.object(titleCardFields);

/** Mirrors `HdrFormat` in `@movies/contracts`. */
export const hdrFormat = v.union(
  v.literal("none"),
  v.literal("hdr10"),
  v.literal("hdr10plus"),
  v.literal("hlg"),
  v.literal("dolby_vision"),
);

/** Mirrors `VideoStream` in `@movies/contracts`. */
export const videoStream = v.object({
  index: v.number(),
  codec: v.string(),
  profile: nullable(v.string()),
  width: v.number(),
  height: v.number(),
  frameRate: nullable(v.number()),
  bitDepth: nullable(v.number()),
  pixelFormat: nullable(v.string()),
  hdr: hdrFormat,
  bitRate: nullable(v.number()),
});

/** Mirrors `AudioStream` in `@movies/contracts`. */
export const audioStream = v.object({
  index: v.number(),
  codec: v.string(),
  profile: nullable(v.string()),
  channels: v.number(),
  channelLayout: nullable(v.string()),
  language: nullable(v.string()),
  title: nullable(v.string()),
  default: v.boolean(),
  bitRate: nullable(v.number()),
});

/** Mirrors `SubtitleStream` in `@movies/contracts`. */
export const subtitleStream = v.object({
  index: v.number(),
  codec: v.string(),
  kind: v.union(v.literal("text"), v.literal("image")),
  language: nullable(v.string()),
  title: nullable(v.string()),
  default: v.boolean(),
  forced: v.boolean(),
});

/** Mirrors `Probe` in `@movies/contracts`. */
export const probe = v.object({
  container: v.string(),
  durationMs: v.number(),
  bitRate: nullable(v.number()),
  video: v.array(videoStream),
  audio: v.array(audioStream),
  subtitles: v.array(subtitleStream),
});

/** Mirrors `ExternalSubtitle` in `@movies/contracts`. */
export const externalSubtitle = v.object({
  fileName: v.string(),
  codec: v.string(),
  language: nullable(v.string()),
  forced: v.boolean(),
});

/** Mirrors `MediaFile` in `@movies/contracts`. */
export const mediaFile = v.object({
  id: v.id("mediaFiles"),
  titleId: v.id("titles"),
  episodeId: nullable(v.id("episodes")),
  versionName: nullable(v.string()),
  sizeBytes: v.number(),
  probe,
  externalSubtitles: v.array(externalSubtitle),
  hdr: v.boolean(),
  missing: v.boolean(),
});

/** Mirrors `Progress` in `@movies/contracts`. */
export const progress = v.object({
  positionMs: v.number(),
  durationMs: v.number(),
  watched: v.boolean(),
  updatedAt: v.number(),
});

/** Mirrors `Episode` in `@movies/contracts`. */
export const episode = v.object({
  id: v.id("episodes"),
  titleId: v.id("titles"),
  seasonId: v.id("seasons"),
  seasonNumber: v.number(),
  episodeNumber: v.number(),
  name: v.string(),
  overview: nullable(v.string()),
  airDate: nullable(v.string()),
  runtimeMs: nullable(v.number()),
  still: nullable(v.string()),
  available: v.boolean(),
  progress: nullable(progress),
});

/** Mirrors `Season` in `@movies/contracts`. */
export const season = v.object({
  id: v.id("seasons"),
  seasonNumber: v.number(),
  name: v.string(),
  poster: nullable(v.string()),
  episodeCount: v.number(),
});

/** Mirrors `TitleDetail` in `@movies/contracts`. */
export const titleDetail = v.object({
  ...titleCardFields,
  libraryId: v.id("libraries"),
  sortName: v.string(),
  overview: nullable(v.string()),
  tagline: nullable(v.string()),
  externalIds,
  matchStatus,
  seasons: v.array(season),
  files: v.array(mediaFile),
  progress: nullable(progress),
  nextEpisode: nullable(episode),
  inMyList: v.boolean(),
});

/** Mirrors `ContinueWatchingItem` in `@movies/contracts`. */
export const continueWatchingItem = v.object({
  reason: v.union(v.literal("resume"), v.literal("next")),
  title: titleCard,
  episode: nullable(episode),
  progress: nullable(progress),
});

/** Mirrors `Home` in `@movies/contracts`. */
export const home = v.object({
  featured: nullable(titleCard),
  continueWatching: v.array(continueWatchingItem),
  myList: v.array(titleCard),
  recentlyAddedMovies: v.array(titleCard),
  recentlyAddedShows: v.array(titleCard),
});

/** Mirrors `HistoryEntry` in `@movies/contracts`. */
export const historyEntry = v.object({
  title: titleCard,
  episode: nullable(episode),
  progress,
  lastPlayedAt: v.number(),
});

/** Mirrors `TitleSort` in `@movies/contracts`. */
export const titleSort = v.union(v.literal("name"), v.literal("added"), v.literal("year"));

/** Mirrors `MetadataOverrides` in `@movies/contracts`. */
export const metadataOverrides = v.object({
  name: v.optional(v.string()),
  sortName: v.optional(v.string()),
  year: v.optional(v.number()),
  overview: v.optional(v.string()),
  certification: v.optional(v.string()),
  ageRating: v.optional(v.number()),
});

/** Mirrors `MetadataField` in `@movies/contracts`. */
export const metadataField = v.union(
  v.literal("name"),
  v.literal("sortName"),
  v.literal("year"),
  v.literal("overview"),
  v.literal("certification"),
  v.literal("ageRating"),
);

// Playback.

/** Mirrors `PlaybackMode` in `@movies/contracts`. */
export const playbackMode = v.union(
  v.literal("direct"),
  v.literal("remux"),
  v.literal("transcode-qsv"),
  v.literal("transcode-software"),
);

/** Mirrors `PlaybackSession` in `@movies/contracts`. */
export const playbackSession = v.object({
  id: v.id("playbackSessions"),
  profileId: v.id("profiles"),
  deviceId: v.string(),
  deviceName: nullable(v.string()),
  titleId: v.id("titles"),
  episodeId: nullable(v.id("episodes")),
  fileId: v.id("mediaFiles"),
  mode: nullable(playbackMode),
  positionMs: v.number(),
  state: v.union(v.literal("playing"), v.literal("paused")),
  startedAt: v.number(),
  lastReportAt: v.number(),
});

/** Mirrors `StartedPlayback` in `@movies/contracts`. */
export const startedPlayback = v.object({
  sessionId: v.id("playbackSessions"),
  titleId: v.id("titles"),
  episodeId: nullable(v.id("episodes")),
  file: mediaFile,
  token: v.string(),
  tokenExpiresAt: v.number(),
  mediaBaseUrl: v.string(),
  resumePositionMs: v.number(),
});

/** Mirrors `RenewedToken` in `@movies/contracts`. */
export const renewedToken = v.object({ token: v.string(), tokenExpiresAt: v.number() });

/** Mirrors `ProgressEvent` in `@movies/contracts`. */
export const progressEvent = v.union(
  v.literal("tick"),
  v.literal("pause"),
  v.literal("resume"),
  v.literal("seek"),
  v.literal("ended"),
);

/** Mirrors `ProgressReceipt` in `@movies/contracts`. */
export const progressReceipt = v.object({ applied: v.boolean(), watched: v.boolean() });

// Rooms.

/** Mirrors `RoomStatus` in `@movies/contracts`. */
export const roomStatus = v.union(
  v.literal("playing"),
  v.literal("paused"),
  v.literal("buffering"),
  v.literal("ended"),
);

/** Mirrors `RoomClock` in `@movies/contracts`. */
export const roomClock = v.object({
  status: roomStatus,
  positionAtAnchorMs: v.number(),
  anchorServerTime: v.number(),
  playbackRate: v.number(),
  revision: v.number(),
});

/** Mirrors `RoomMember` in `@movies/contracts`. */
export const roomMember = v.object({
  userId: v.id("users"),
  profileId: v.id("profiles"),
  profileName: v.string(),
  avatar: v.string(),
  deviceId: v.string(),
  role: v.union(v.literal("host"), v.literal("guest")),
  joinedAt: v.number(),
  lastSeenAt: v.number(),
});

/** Mirrors `Room` in `@movies/contracts`. */
export const room = v.object({
  id: v.id("rooms"),
  title: titleCard,
  episode: nullable(episode),
  fileId: v.id("mediaFiles"),
  hostUserId: v.id("users"),
  hostProfileId: v.id("profiles"),
  hostDeviceId: v.string(),
  hostAway: v.boolean(),
  clock: roomClock,
  members: v.array(roomMember),
  createdAt: v.number(),
});

/** Arguments of every host room control; mirrors `HostControlArgs` in contracts. */
export const hostControlArgs = {
  roomId: v.id("rooms"),
  deviceId: v.string(),
  revision: v.number(),
  positionMs: v.number(),
};

// Jobs and backups.

/** Mirrors `JobKind` in `@movies/contracts`. */
export const jobKind = v.union(
  v.literal("scan"),
  v.literal("metadata"),
  v.literal("backup"),
  v.literal("migration"),
);

/** Mirrors `JobStatus` in `@movies/contracts`. */
export const jobStatus = v.union(
  v.literal("pending"),
  v.literal("running"),
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("cancelled"),
);

/** Mirrors `ScanMode` in `@movies/contracts`. */
export const scanMode = v.union(v.literal("full"), v.literal("quick"));

/** Mirrors `MigrationSource` in `@movies/contracts`. */
export const migrationSource = v.union(v.literal("jellyfin"), v.literal("plex"));

/** Why a backup ran: the nightly cron or an admin. */
export const backupTrigger = v.union(v.literal("nightly"), v.literal("manual"));

/** Mirrors `JobPayload` in `@movies/contracts`. */
export const jobPayload = v.union(
  v.object({ kind: v.literal("scan"), libraryId: v.id("libraries"), mode: scanMode }),
  v.object({
    kind: v.literal("metadata"),
    titleId: v.id("titles"),
    match: nullable(v.object({ provider: v.literal("tmdb"), providerId: v.string() })),
  }),
  v.object({ kind: v.literal("backup"), trigger: backupTrigger }),
  v.object({
    kind: v.literal("migration"),
    source: migrationSource,
    connectionId: v.string(),
    serverName: v.string(),
  }),
);

/** Mirrors `JobProgress` in `@movies/contracts`. */
export const jobProgress = v.object({
  done: v.number(),
  total: nullable(v.number()),
  message: nullable(v.string()),
});

/** Mirrors `Job` in `@movies/contracts`. */
export const job = v.object({
  id: v.id("jobs"),
  kind: jobKind,
  status: jobStatus,
  payload: jobPayload,
  progress: jobProgress,
  error: nullable(v.string()),
  requestedBy: nullable(v.id("users")),
  attempts: v.number(),
  createdAt: v.number(),
  startedAt: nullable(v.number()),
  finishedAt: nullable(v.number()),
});

/** Mirrors `QueuedJob` in `@movies/contracts`. */
export const queuedJob = v.object({ jobId: v.id("jobs") });

/** Mirrors `Backup` in `@movies/contracts`. */
export const backup = v.object({
  id: v.id("backups"),
  fileName: v.string(),
  sizeBytes: v.number(),
  trigger: backupTrigger,
  createdAt: v.number(),
});

// The media service seam.

/** Arguments naming a job and the worker that holds its lease; mirrors `LeaseArgs` in contracts. */
export const leaseArgs = { jobId: v.id("jobs"), workerId: v.string() };

/** Mirrors `MediaLibrary` in `@movies/contracts`. */
export const mediaLibrary = v.object({
  id: v.id("libraries"),
  name: v.string(),
  kind: libraryKind,
  roots: v.array(v.string()),
});

/** Mirrors `ClaimedJob` in `@movies/contracts`. */
export const claimedJob = v.object({
  job,
  library: nullable(mediaLibrary),
  leaseExpiresAt: v.number(),
});

/** Mirrors `ScannedTitle` in `@movies/contracts`. */
export const scannedTitle = v.object({
  kind: titleKind,
  matchKey: v.string(),
  name: v.string(),
  sortName: nullable(v.string()),
  year: nullable(v.number()),
  overview: nullable(v.string()),
  tagline: nullable(v.string()),
  genres: v.array(v.string()),
  certification: nullable(v.string()),
  ageRating: nullable(v.number()),
  runtimeMs: nullable(v.number()),
  artwork,
  externalIds,
  matchStatus: v.union(v.literal("matched"), v.literal("unmatched")),
});

/** Mirrors `ScannedEpisode` in `@movies/contracts`. */
export const scannedEpisode = v.object({
  seasonNumber: v.number(),
  episodeNumber: v.number(),
  name: nullable(v.string()),
  overview: nullable(v.string()),
  airDate: nullable(v.string()),
  runtimeMs: nullable(v.number()),
  still: nullable(v.string()),
  seasonName: nullable(v.string()),
  seasonPoster: nullable(v.string()),
});

/** Mirrors `ScannedFile` in `@movies/contracts`. */
export const scannedFile = v.object({
  path: v.string(),
  sizeBytes: v.number(),
  mtimeMs: v.number(),
  probe,
  externalSubtitles: v.array(externalSubtitle),
  versionName: nullable(v.string()),
});

/** Mirrors `ScannedItem` in `@movies/contracts`. */
export const scannedItem = v.object({
  file: scannedFile,
  title: scannedTitle,
  episode: nullable(scannedEpisode),
});

/** Mirrors `UpsertedFile` in `@movies/contracts`. */
export const upsertedFile = v.object({
  path: v.string(),
  fileId: v.id("mediaFiles"),
  titleId: v.id("titles"),
  episodeId: nullable(v.id("episodes")),
});

/** Mirrors `IndexedFile` in `@movies/contracts`. */
export const indexedFile = v.object({
  path: v.string(),
  sizeBytes: v.number(),
  mtimeMs: v.number(),
  missing: v.boolean(),
});

/** Mirrors `ResolvedFile` in `@movies/contracts`. */
export const resolvedFile = v.object({
  fileId: v.id("mediaFiles"),
  libraryId: v.id("libraries"),
  path: v.string(),
  roots: v.array(v.string()),
  probe,
  externalSubtitles: v.array(externalSubtitle),
  missing: v.boolean(),
});

/** Mirrors `SessionStatus` in `@movies/contracts`. */
export const sessionStatus = v.object({
  sessionId: v.id("playbackSessions"),
  status: v.union(v.literal("active"), v.literal("ended")),
  fileId: v.id("mediaFiles"),
  endedAt: nullable(v.number()),
});

/** Mirrors `EndedSession` in `@movies/contracts`. */
export const endedSession = v.object({ sessionId: v.id("playbackSessions"), endedAt: v.number() });

/** Mirrors `MetadataTarget` in `@movies/contracts`. */
export const metadataTarget = v.object({
  titleId: v.id("titles"),
  libraryId: v.id("libraries"),
  kind: titleKind,
  name: v.string(),
  year: nullable(v.number()),
  externalIds,
  episodes: v.array(v.object({ seasonNumber: v.number(), episodeNumber: v.number() })),
});

/** Mirrors `MigrationTarget` in `@movies/contracts`. */
export const migrationTarget = v.object({
  userId: v.id("users"),
  name: v.string(),
  email: nullable(v.string()),
  profiles: v.array(v.object({ profileId: v.id("profiles"), name: v.string() })),
});

/** Mirrors `ImportedWatchState` in `@movies/contracts`. */
export const importedWatchState = v.object({
  profileId: v.id("profiles"),
  path: v.string(),
  watched: v.boolean(),
  positionMs: v.number(),
  lastPlayedAt: nullable(v.number()),
  favorite: v.boolean(),
});

/** Mirrors `ImportedOverride` in `@movies/contracts`. */
export const importedOverride = v.object({ path: v.string(), overrides: metadataOverrides });

/** Mirrors `ImportCounts` in `@movies/contracts`. */
export const importCounts = v.object({ matched: v.number(), unmatched: v.number() });
