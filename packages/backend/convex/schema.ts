import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

import {
  apiKeyScope,
  artwork,
  assignableRole,
  backupTrigger,
  deviceScope,
  externalIds,
  externalSubtitle,
  jobKind,
  jobPayload,
  jobProgress,
  jobStatus,
  libraryAccess,
  libraryKind,
  matchStatus,
  metadataOverrides,
  nullable,
  playbackMode,
  probe,
  role,
  roomStatus,
  scope,
  titleKind,
} from "./lib/validators";

/**
 * What a restricted session may do. Password sessions have no grant and hold every scope their
 * role allows. The grant lives on the session row itself, so deleting the session deletes the
 * grant and a restricted session can never outlive it as an unrestricted one.
 */
export const sessionGrant = v.object({
  kind: v.union(v.literal("apikey"), v.literal("device")),
  scopes: v.array(scope),
  label: v.string(),
  apiKeyId: v.optional(v.id("apiKeys")),
  deviceCodeId: v.optional(v.id("deviceCodes")),
});

export default defineSchema({
  ...authTables,

  /** Convex Auth sessions, extended with the grant and the PIN profiles this session unlocked. */
  authSessions: defineTable({
    userId: v.id("users"),
    expirationTime: v.number(),
    grant: v.optional(sessionGrant),
    unlockedProfiles: v.optional(v.array(v.id("profiles"))),
  }).index("userId", ["userId"]),

  users: defineTable({
    name: v.optional(v.string()),
    image: v.optional(v.string()),
    email: v.optional(v.string()),
    emailVerificationTime: v.optional(v.number()),
    phone: v.optional(v.string()),
    phoneVerificationTime: v.optional(v.number()),
    isAnonymous: v.optional(v.boolean()),
    role,
    disabledAt: v.optional(v.number()),
    /** Only carried from the sign-up form to `createOrUpdateUser`; never stored. */
    inviteCode: v.optional(v.string()),
  })
    .index("email", ["email"])
    .index("by_role", ["role"]),

  invites: defineTable({
    /** SHA-256 of the invite code, hex. The code is shown once and never stored. */
    codeHash: v.string(),
    email: nullable(v.string()),
    role: assignableRole,
    createdBy: v.id("users"),
    expiresAt: v.number(),
    acceptedBy: v.optional(v.id("users")),
    acceptedAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
  }).index("by_code_hash", ["codeHash"]),

  apiKeys: defineTable({
    userId: v.id("users"),
    name: v.string(),
    prefix: v.string(),
    /** SHA-256 of the key, hex. The key itself is shown once and never stored. */
    hash: v.string(),
    scopes: v.array(apiKeyScope),
    expiresAt: v.optional(v.number()),
    lastUsedAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
    /** The auth session every sign-in with this key shares; revoking the key deletes it. */
    sessionId: v.optional(v.id("authSessions")),
    /** The media service's key, created by `scripts/configure.ts`. Holds `media-service` only. */
    service: v.optional(v.boolean()),
  })
    .index("by_hash", ["hash"])
    .index("by_user", ["userId"]),

  deviceCodes: defineTable({
    /** SHA-256 of the secret device code, hex. */
    deviceCodeHash: v.string(),
    userCode: v.string(),
    clientName: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("approved"),
      v.literal("denied"),
      v.literal("expired"),
      v.literal("consumed"),
    ),
    expiresAt: v.number(),
    decidedBy: v.optional(v.id("users")),
    scopes: v.optional(v.array(deviceScope)),
    consumedAt: v.optional(v.number()),
  })
    .index("by_hash", ["deviceCodeHash"])
    .index("by_user_code", ["userCode"])
    .index("by_expires", ["expiresAt"]),

  profiles: defineTable({
    userId: v.id("users"),
    name: v.string(),
    avatar: v.string(),
    kids: v.boolean(),
    maxAgeRating: nullable(v.number()),
    /** PBKDF2-SHA256 of the PIN with `pinSalt`, base64url. */
    pinHash: v.optional(v.string()),
    pinSalt: v.optional(v.string()),
    pinFailures: v.number(),
    pinLockedUntil: v.optional(v.number()),
  }).index("by_user", ["userId"]),

  libraries: defineTable({
    name: v.string(),
    kind: libraryKind,
    roots: v.array(v.string()),
    access: libraryAccess,
    createdBy: v.id("users"),
    titleCount: v.number(),
    lastScanAt: nullable(v.number()),
  }),

  libraryGrants: defineTable({
    userId: v.id("users"),
    libraryId: v.id("libraries"),
  })
    .index("by_user", ["userId"])
    .index("by_library", ["libraryId"]),

  titles: defineTable({
    libraryId: v.id("libraries"),
    kind: titleKind,
    /** Identifies the title within its library across scans, such as `tmdb:603`. */
    matchKey: v.string(),
    name: v.string(),
    sortName: v.string(),
    /** Lowercased sort name for ordering. */
    sortKey: v.string(),
    year: nullable(v.number()),
    overview: nullable(v.string()),
    tagline: nullable(v.string()),
    genres: v.array(v.string()),
    certification: nullable(v.string()),
    ageRating: nullable(v.number()),
    runtimeMs: nullable(v.number()),
    artwork,
    externalIds,
    matchStatus,
    /** Admin edits; presentation prefers them and scans never overwrite them. */
    overrides: v.optional(metadataOverrides),
    /** Files of this title (or its episodes) present on disk. Zero means unavailable. */
    presentFileCount: v.number(),
    addedAt: v.number(),
    updatedAt: v.number(),
    searchText: v.string(),
  })
    .index("by_library_match", ["libraryId", "matchKey"])
    .index("by_library", ["libraryId"])
    .index("by_library_status", ["libraryId", "matchStatus"])
    .index("by_kind_sort", ["kind", "sortKey"])
    .index("by_kind_added", ["kind", "addedAt"])
    .index("by_kind_year", ["kind", "year"])
    .index("by_sort", ["sortKey"])
    .index("by_added", ["addedAt"])
    .index("by_year", ["year"])
    .searchIndex("search_text", { searchField: "searchText", filterFields: ["kind"] }),

  seasons: defineTable({
    titleId: v.id("titles"),
    seasonNumber: v.number(),
    name: v.string(),
    poster: nullable(v.string()),
    episodeCount: v.number(),
  }).index("by_title_number", ["titleId", "seasonNumber"]),

  episodes: defineTable({
    titleId: v.id("titles"),
    seasonId: v.id("seasons"),
    seasonNumber: v.number(),
    episodeNumber: v.number(),
    name: v.string(),
    overview: nullable(v.string()),
    airDate: nullable(v.string()),
    runtimeMs: nullable(v.number()),
    still: nullable(v.string()),
    presentFileCount: v.number(),
  }).index("by_title_order", ["titleId", "seasonNumber", "episodeNumber"]),

  mediaFiles: defineTable({
    libraryId: v.id("libraries"),
    titleId: v.id("titles"),
    episodeId: nullable(v.id("episodes")),
    path: v.string(),
    sizeBytes: v.number(),
    mtimeMs: v.number(),
    probe,
    externalSubtitles: v.array(externalSubtitle),
    versionName: nullable(v.string()),
    hdr: v.boolean(),
    missing: v.boolean(),
    missingSince: v.optional(v.number()),
    addedAt: v.number(),
  })
    .index("by_library_path", ["libraryId", "path"])
    .index("by_library_missing", ["libraryId", "missing"])
    .index("by_path", ["path"])
    .index("by_title", ["titleId"])
    .index("by_episode", ["episodeId"]),

  watchProgress: defineTable({
    profileId: v.id("profiles"),
    titleId: v.id("titles"),
    /** The episode for shows; null for movies. */
    episodeId: nullable(v.id("episodes")),
    fileId: nullable(v.id("mediaFiles")),
    positionMs: v.number(),
    durationMs: v.number(),
    watched: v.boolean(),
    updatedAt: v.number(),
    lastPlayedAt: v.number(),
    /** The playback session that owns this progress; older sessions cannot overwrite it. */
    sessionId: v.optional(v.id("playbackSessions")),
    sessionStartedAt: v.optional(v.number()),
  })
    .index("by_profile_item", ["profileId", "titleId", "episodeId"])
    .index("by_profile_played", ["profileId", "lastPlayedAt"]),

  myList: defineTable({
    profileId: v.id("profiles"),
    titleId: v.id("titles"),
    addedAt: v.number(),
  })
    .index("by_profile_added", ["profileId", "addedAt"])
    .index("by_profile_title", ["profileId", "titleId"]),

  playbackSessions: defineTable({
    userId: v.id("users"),
    profileId: v.id("profiles"),
    /** The sign-in that started it; ending that sign-in ends this session. */
    authSessionId: v.id("authSessions"),
    deviceId: v.string(),
    deviceName: nullable(v.string()),
    titleId: v.id("titles"),
    episodeId: nullable(v.id("episodes")),
    fileId: v.id("mediaFiles"),
    roomId: nullable(v.id("rooms")),
    mode: nullable(playbackMode),
    status: v.union(v.literal("active"), v.literal("ended")),
    state: v.union(v.literal("playing"), v.literal("paused")),
    positionMs: v.number(),
    startedAt: v.number(),
    lastReportAt: v.number(),
    endedAt: nullable(v.number()),
  })
    .index("by_status_ended", ["status", "endedAt"])
    .index("by_status_report", ["status", "lastReportAt"])
    .index("by_user_status", ["userId", "status"])
    .index("by_auth_session", ["authSessionId"]),

  rooms: defineTable({
    titleId: v.id("titles"),
    episodeId: nullable(v.id("episodes")),
    fileId: v.id("mediaFiles"),
    hostUserId: v.id("users"),
    hostProfileId: v.id("profiles"),
    hostDeviceId: v.string(),
    status: roomStatus,
    positionAtAnchorMs: v.number(),
    anchorServerTime: v.number(),
    playbackRate: v.number(),
    revision: v.number(),
    hostLastSeenAt: v.number(),
    hostAway: v.boolean(),
    endedAt: v.optional(v.number()),
  }).index("by_status", ["status"]),

  roomMembers: defineTable({
    roomId: v.id("rooms"),
    userId: v.id("users"),
    profileId: v.id("profiles"),
    deviceId: v.string(),
    role: v.union(v.literal("host"), v.literal("guest")),
    joinedAt: v.number(),
    lastSeenAt: v.number(),
    /** A guest's last reported distance from the shared position; absent until it reports one. */
    driftMs: v.optional(v.number()),
  })
    .index("by_room_device", ["roomId", "deviceId"])
    .index("by_user_device", ["userId", "deviceId"]),

  jobs: defineTable({
    kind: jobKind,
    status: jobStatus,
    payload: jobPayload,
    progress: jobProgress,
    error: nullable(v.string()),
    requestedBy: nullable(v.id("users")),
    attempts: v.number(),
    leaseOwner: v.optional(v.string()),
    leaseExpiresAt: v.optional(v.number()),
    startedAt: nullable(v.number()),
    finishedAt: nullable(v.number()),
    /** For scan jobs, the library, so a library shows whether it is scanning. */
    libraryId: v.optional(v.id("libraries")),
  })
    .index("by_status", ["status"])
    .index("by_kind_status", ["kind", "status"])
    .index("by_library_status", ["libraryId", "status"]),

  backups: defineTable({
    fileName: v.string(),
    sizeBytes: v.number(),
    trigger: backupTrigger,
    jobId: v.optional(v.id("jobs")),
  }),
});
