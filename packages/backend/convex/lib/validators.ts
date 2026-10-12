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

export const ok = v.object({ ok: v.literal(true) });

export const pageArgs = {
  cursor: v.optional(nullable(v.string())),
  limit: v.optional(v.number()),
};

/** A page of `item`; `nextCursor` is null on the last page. */
export const page = <T, FieldPaths extends string>(item: Validator<T, "required", FieldPaths>) =>
  v.object({ items: v.array(item), nextCursor: nullable(v.string()) });

// Accounts and sessions.

export const role = v.union(
  v.literal("owner"),
  v.literal("admin"),
  v.literal("member"),
  v.literal("service"),
);

export const assignableRole = v.union(v.literal("admin"), v.literal("member"));

export const scope = v.union(
  v.literal("read"),
  v.literal("play"),
  v.literal("account"),
  v.literal("manage"),
  v.literal("admin"),
  v.literal("media-service"),
);

export const apiKeyScope = v.union(
  v.literal("read"),
  v.literal("play"),
  v.literal("manage"),
  v.literal("admin"),
);

export const deviceScope = v.union(
  v.literal("read"),
  v.literal("play"),
  v.literal("account"),
  v.literal("manage"),
  v.literal("admin"),
);

export const sessionKind = v.union(v.literal("password"), v.literal("apikey"), v.literal("device"));

export const user = v.object({
  id: v.id("users"),
  email: nullable(v.string()),
  name: v.string(),
  role,
  disabled: v.boolean(),
  createdAt: v.number(),
});

export const viewer = v.object({
  user,
  sessionId: v.id("authSessions"),
  sessionKind,
  scopes: v.array(scope),
});

export const sessionInfo = v.object({
  id: v.id("authSessions"),
  kind: sessionKind,
  label: nullable(v.string()),
  scopes: v.array(scope),
  createdAt: v.number(),
  expiresAt: v.number(),
  current: v.boolean(),
});

export const setupStatus = v.object({ hasOwner: v.boolean(), hasLibraries: v.boolean() });

export const inviteState = v.union(
  v.literal("open"),
  v.literal("used"),
  v.literal("expired"),
  v.literal("revoked"),
);

export const invite = v.object({
  id: v.id("invites"),
  email: nullable(v.string()),
  role: assignableRole,
  state: inviteState,
  createdBy: v.id("users"),
  createdAt: v.number(),
  expiresAt: v.number(),
});

export const createdInvite = v.object({ invite, code: v.string(), url: v.string() });

export const inviteLookup = v.union(
  v.object({ state: v.literal("invalid") }),
  v.object({
    state: v.union(v.literal("open"), v.literal("used"), v.literal("expired")),
    email: nullable(v.string()),
    inviterName: v.string(),
    expiresAt: v.number(),
  }),
);

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

export const createdApiKey = v.object({ apiKey, secret: v.string() });

export const deviceCodeRequest = v.object({
  deviceCode: v.string(),
  userCode: v.string(),
  verificationUrl: v.string(),
  expiresAt: v.number(),
});

export const deviceCodeState = v.union(
  v.literal("pending"),
  v.literal("approved"),
  v.literal("denied"),
  v.literal("expired"),
  v.literal("consumed"),
);

export const deviceCodeLookup = v.object({
  userCode: v.string(),
  clientName: v.string(),
  state: deviceCodeState,
  requestedAt: v.number(),
  expiresAt: v.number(),
});

// Profiles.

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

export const unlockResult = v.union(
  v.object({ status: v.literal("unlocked") }),
  v.object({ status: v.literal("wrong_pin"), attemptsLeft: v.number() }),
  v.object({ status: v.literal("locked_out"), retryAt: v.number() }),
);

// Catalog.

export const libraryKind = v.union(v.literal("movies"), v.literal("shows"), v.literal("mixed"));

export const libraryAccess = v.union(v.literal("everyone"), v.literal("restricted"));

const libraryFields = {
  id: v.id("libraries"),
  name: v.string(),
  kind: libraryKind,
  titleCount: v.number(),
  lastScanAt: nullable(v.number()),
  scanning: v.boolean(),
};

export const library = v.object(libraryFields);

export const libraryDetail = v.object({
  ...libraryFields,
  roots: v.array(v.string()),
  access: libraryAccess,
  grantedUserIds: v.array(v.id("users")),
  createdAt: v.number(),
});

export const titleKind = v.union(v.literal("movie"), v.literal("show"));

export const matchStatus = v.union(
  v.literal("matched"),
  v.literal("unmatched"),
  v.literal("manual"),
);

export const externalIds = v.object({
  tmdb: nullable(v.string()),
  imdb: nullable(v.string()),
  tvdb: nullable(v.string()),
});

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

export const titleCard = v.object(titleCardFields);

export const hdrFormat = v.union(
  v.literal("none"),
  v.literal("hdr10"),
  v.literal("hdr10plus"),
  v.literal("hlg"),
  v.literal("dolby_vision"),
);

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

export const subtitleStream = v.object({
  index: v.number(),
  codec: v.string(),
  kind: v.union(v.literal("text"), v.literal("image")),
  language: nullable(v.string()),
  title: nullable(v.string()),
  default: v.boolean(),
  forced: v.boolean(),
});

export const probe = v.object({
  container: v.string(),
  durationMs: v.number(),
  bitRate: nullable(v.number()),
  video: v.array(videoStream),
  audio: v.array(audioStream),
  subtitles: v.array(subtitleStream),
});

export const externalSubtitle = v.object({
  fileName: v.string(),
  codec: v.string(),
  language: nullable(v.string()),
  forced: v.boolean(),
});

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

export const progress = v.object({
  positionMs: v.number(),
  durationMs: v.number(),
  watched: v.boolean(),
  updatedAt: v.number(),
});

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

export const season = v.object({
  id: v.id("seasons"),
  seasonNumber: v.number(),
  name: v.string(),
  poster: nullable(v.string()),
  episodeCount: v.number(),
});

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

export const continueWatchingItem = v.object({
  reason: v.union(v.literal("resume"), v.literal("next")),
  title: titleCard,
  episode: nullable(episode),
  progress: nullable(progress),
});

export const home = v.object({
  featured: nullable(titleCard),
  continueWatching: v.array(continueWatchingItem),
  myList: v.array(titleCard),
  recentlyAddedMovies: v.array(titleCard),
  recentlyAddedShows: v.array(titleCard),
});

export const historyEntry = v.object({
  title: titleCard,
  episode: nullable(episode),
  progress,
  lastPlayedAt: v.number(),
});

export const titleSort = v.union(v.literal("name"), v.literal("added"), v.literal("year"));

export const metadataOverrides = v.object({
  name: v.optional(v.string()),
  sortName: v.optional(v.string()),
  year: v.optional(v.number()),
  overview: v.optional(v.string()),
  certification: v.optional(v.string()),
  ageRating: v.optional(v.number()),
});

export const metadataField = v.union(
  v.literal("name"),
  v.literal("sortName"),
  v.literal("year"),
  v.literal("overview"),
  v.literal("certification"),
  v.literal("ageRating"),
);

// Playback.

export const playbackMode = v.union(
  v.literal("direct"),
  v.literal("remux"),
  v.literal("transcode-qsv"),
  v.literal("transcode-software"),
);

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

export const renewedToken = v.object({ token: v.string(), tokenExpiresAt: v.number() });

export const progressEvent = v.union(
  v.literal("tick"),
  v.literal("pause"),
  v.literal("resume"),
  v.literal("seek"),
  v.literal("ended"),
);

export const progressReceipt = v.object({ applied: v.boolean(), watched: v.boolean() });

// Rooms.

export const roomStatus = v.union(
  v.literal("playing"),
  v.literal("paused"),
  v.literal("buffering"),
  v.literal("ended"),
);

export const roomClock = v.object({
  status: roomStatus,
  positionAtAnchorMs: v.number(),
  anchorServerTime: v.number(),
  playbackRate: v.number(),
  revision: v.number(),
});

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

export const hostControlArgs = {
  roomId: v.id("rooms"),
  deviceId: v.string(),
  revision: v.number(),
  positionMs: v.number(),
};

// Jobs and backups.

export const jobKind = v.union(
  v.literal("scan"),
  v.literal("metadata"),
  v.literal("backup"),
  v.literal("migration"),
);

export const jobStatus = v.union(
  v.literal("pending"),
  v.literal("running"),
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("cancelled"),
);

export const scanMode = v.union(v.literal("full"), v.literal("quick"));

export const migrationSource = v.union(v.literal("jellyfin"), v.literal("plex"));

export const backupTrigger = v.union(v.literal("nightly"), v.literal("manual"));

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

export const jobProgress = v.object({
  done: v.number(),
  total: nullable(v.number()),
  message: nullable(v.string()),
});

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

export const queuedJob = v.object({ jobId: v.id("jobs") });

export const backup = v.object({
  id: v.id("backups"),
  fileName: v.string(),
  sizeBytes: v.number(),
  trigger: backupTrigger,
  createdAt: v.number(),
});

// The media service seam.

export const leaseArgs = { jobId: v.id("jobs"), workerId: v.string() };

export const mediaLibrary = v.object({
  id: v.id("libraries"),
  name: v.string(),
  kind: libraryKind,
  roots: v.array(v.string()),
});

export const claimedJob = v.object({
  job,
  library: nullable(mediaLibrary),
  leaseExpiresAt: v.number(),
});

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

export const scannedFile = v.object({
  path: v.string(),
  sizeBytes: v.number(),
  mtimeMs: v.number(),
  probe,
  externalSubtitles: v.array(externalSubtitle),
  versionName: nullable(v.string()),
});

export const scannedItem = v.object({
  file: scannedFile,
  title: scannedTitle,
  episode: nullable(scannedEpisode),
});

export const upsertedFile = v.object({
  path: v.string(),
  fileId: v.id("mediaFiles"),
  titleId: v.id("titles"),
  episodeId: nullable(v.id("episodes")),
});

export const indexedFile = v.object({
  path: v.string(),
  sizeBytes: v.number(),
  mtimeMs: v.number(),
  missing: v.boolean(),
});

export const resolvedFile = v.object({
  fileId: v.id("mediaFiles"),
  libraryId: v.id("libraries"),
  path: v.string(),
  roots: v.array(v.string()),
  probe,
  externalSubtitles: v.array(externalSubtitle),
  missing: v.boolean(),
});

export const sessionStatus = v.object({
  sessionId: v.id("playbackSessions"),
  status: v.union(v.literal("active"), v.literal("ended")),
  fileId: v.id("mediaFiles"),
  endedAt: nullable(v.number()),
});

export const endedSession = v.object({ sessionId: v.id("playbackSessions"), endedAt: v.number() });

export const metadataTarget = v.object({
  titleId: v.id("titles"),
  libraryId: v.id("libraries"),
  kind: titleKind,
  name: v.string(),
  year: nullable(v.number()),
  externalIds,
  episodes: v.array(v.object({ seasonNumber: v.number(), episodeNumber: v.number() })),
});

export const migrationTarget = v.object({
  userId: v.id("users"),
  name: v.string(),
  email: nullable(v.string()),
  profiles: v.array(v.object({ profileId: v.id("profiles"), name: v.string() })),
});

export const importedWatchState = v.object({
  profileId: v.id("profiles"),
  path: v.string(),
  watched: v.boolean(),
  positionMs: v.number(),
  lastPlayedAt: nullable(v.number()),
  favorite: v.boolean(),
});

export const importedOverride = v.object({ path: v.string(), overrides: metadataOverrides });

export const importCounts = v.object({ matched: v.number(), unmatched: v.number() });
