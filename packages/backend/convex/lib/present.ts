/**
 * Converts documents into command results. Every function here returns the `Infer` of the result
 * validator in `validators.ts`, so a drift between storage and the wire contract fails to compile.
 */
import type { Infer } from "convex/values";

import type { Doc, Id } from "../_generated/dataModel";
import { isProfileUnlocked, titleAgeRating } from "./access";
import type { ReadCtx, Viewer } from "./viewer";
import type {
  apiKey,
  episode,
  invite,
  job,
  library,
  libraryDetail,
  mediaFile,
  playbackSession,
  profile,
  progress,
  roomClock,
  titleCard,
  user,
} from "./validators";

/** Whole milliseconds of a document's creation; `_creationTime` carries a fraction. */
export const createdAt = (doc: { readonly _creationTime: number }): number =>
  Math.floor(doc._creationTime);

/** An account. */
export const presentUser = (doc: Doc<"users">): Infer<typeof user> => ({
  id: doc._id,
  email: doc.email ?? null,
  name: doc.name ?? doc.email ?? "Unnamed",
  role: doc.role,
  disabled: doc.disabledAt !== undefined,
  createdAt: createdAt(doc),
});

/** A profile, with whether this session still has to unlock it. */
export const presentProfile = (viewer: Viewer, doc: Doc<"profiles">): Infer<typeof profile> => ({
  id: doc._id,
  name: doc.name,
  avatar: doc.avatar,
  kids: doc.kids,
  maxAgeRating: doc.maxAgeRating,
  hasPin: doc.pinHash !== undefined,
  locked: !isProfileUnlocked(viewer, doc),
  createdAt: createdAt(doc),
});

/** A title in a row, with admin overrides applied. */
export const presentTitleCard = (doc: Doc<"titles">): Infer<typeof titleCard> => ({
  id: doc._id,
  kind: doc.kind,
  name: doc.overrides?.name ?? doc.name,
  year: doc.overrides?.year ?? doc.year,
  certification: doc.overrides?.certification ?? doc.certification,
  ageRating: titleAgeRating(doc),
  runtimeMs: doc.runtimeMs,
  genres: doc.genres,
  artwork: doc.artwork,
  available: doc.presentFileCount > 0,
  addedAt: doc.addedAt,
});

/** A playable file without its path. */
export const presentMediaFile = (doc: Doc<"mediaFiles">): Infer<typeof mediaFile> => ({
  id: doc._id,
  titleId: doc.titleId,
  episodeId: doc.episodeId,
  versionName: doc.versionName,
  sizeBytes: doc.sizeBytes,
  probe: doc.probe,
  externalSubtitles: doc.externalSubtitles,
  hdr: doc.hdr,
  missing: doc.missing,
});

/** A profile's progress through one item. */
export const presentProgress = (doc: Doc<"watchProgress">): Infer<typeof progress> => ({
  positionMs: doc.positionMs,
  durationMs: doc.durationMs,
  watched: doc.watched,
  updatedAt: doc.updatedAt,
});

/** Loads a profile's progress for a movie (`episodeId` null) or an episode. */
export const findProgress = (
  ctx: ReadCtx,
  profileId: Id<"profiles">,
  titleId: Id<"titles">,
  episodeId: Id<"episodes"> | null,
): Promise<Doc<"watchProgress"> | null> =>
  ctx.db
    .query("watchProgress")
    .withIndex("by_profile_item", (q) =>
      q.eq("profileId", profileId).eq("titleId", titleId).eq("episodeId", episodeId),
    )
    .unique();

/** An episode with the profile's progress through it. */
export const presentEpisode = (
  doc: Doc<"episodes">,
  watch: Doc<"watchProgress"> | null,
): Infer<typeof episode> => ({
  id: doc._id,
  titleId: doc.titleId,
  seasonId: doc.seasonId,
  seasonNumber: doc.seasonNumber,
  episodeNumber: doc.episodeNumber,
  name: doc.name,
  overview: doc.overview,
  airDate: doc.airDate,
  runtimeMs: doc.runtimeMs,
  still: doc.still,
  available: doc.presentFileCount > 0,
  progress: watch === null ? null : presentProgress(watch),
});

/** Loads an episode's progress for the profile and presents both. */
export const presentEpisodeFor = async (
  ctx: ReadCtx,
  profileId: Id<"profiles">,
  doc: Doc<"episodes">,
): Promise<Infer<typeof episode>> =>
  presentEpisode(doc, await findProgress(ctx, profileId, doc.titleId, doc._id));

/** A library as viewers see it. */
export const presentLibrary = (
  doc: Doc<"libraries">,
  scanning: boolean,
): Infer<typeof library> => ({
  id: doc._id,
  name: doc.name,
  kind: doc.kind,
  titleCount: doc.titleCount,
  lastScanAt: doc.lastScanAt,
  scanning,
});

/** A library with its folders and grants, for admins. */
export const presentLibraryDetail = (
  doc: Doc<"libraries">,
  scanning: boolean,
  grantedUserIds: ReadonlyArray<Id<"users">>,
): Infer<typeof libraryDetail> => ({
  ...presentLibrary(doc, scanning),
  roots: doc.roots,
  access: doc.access,
  grantedUserIds: [...grantedUserIds],
  createdAt: createdAt(doc),
});

/** A background job. */
export const presentJob = (doc: Doc<"jobs">): Infer<typeof job> => ({
  id: doc._id,
  kind: doc.kind,
  status: doc.status,
  payload: doc.payload,
  progress: doc.progress,
  error: doc.error,
  requestedBy: doc.requestedBy,
  attempts: doc.attempts,
  createdAt: createdAt(doc),
  startedAt: doc.startedAt,
  finishedAt: doc.finishedAt,
});

/** An API key without its hash. */
export const presentApiKey = (doc: Doc<"apiKeys">): Infer<typeof apiKey> => ({
  id: doc._id,
  userId: doc.userId,
  name: doc.name,
  prefix: doc.prefix,
  scopes: doc.scopes,
  createdAt: createdAt(doc),
  lastUsedAt: doc.lastUsedAt ?? null,
  expiresAt: doc.expiresAt ?? null,
  revokedAt: doc.revokedAt ?? null,
});

/** An invite and its state at `now`. */
export const presentInvite = (doc: Doc<"invites">, now: number): Infer<typeof invite> => ({
  id: doc._id,
  email: doc.email,
  role: doc.role,
  state:
    doc.revokedAt !== undefined
      ? "revoked"
      : doc.acceptedBy !== undefined
        ? "used"
        : doc.expiresAt <= now
          ? "expired"
          : "open",
  createdBy: doc.createdBy,
  createdAt: createdAt(doc),
  expiresAt: doc.expiresAt,
});

/** A room's committed clock. */
export const presentRoomClock = (doc: Doc<"rooms">): Infer<typeof roomClock> => ({
  status: doc.status,
  positionAtAnchorMs: doc.positionAtAnchorMs,
  anchorServerTime: doc.anchorServerTime,
  playbackRate: doc.playbackRate,
  revision: doc.revision,
});

/** A device's playback session. */
export const presentPlaybackSession = (
  doc: Doc<"playbackSessions">,
): Infer<typeof playbackSession> => ({
  id: doc._id,
  profileId: doc.profileId,
  deviceId: doc.deviceId,
  deviceName: doc.deviceName,
  titleId: doc.titleId,
  episodeId: doc.episodeId,
  fileId: doc.fileId,
  mode: doc.mode,
  positionMs: doc.positionMs,
  state: doc.state,
  startedAt: doc.startedAt,
  lastReportAt: doc.lastReportAt,
});
