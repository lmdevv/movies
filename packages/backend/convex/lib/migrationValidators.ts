/**
 * Validators for migration and collections. Each mirrors the schema of the same name in
 * `@movies/contracts/models/migration`, `migration-service`, or `collections`; the registry test
 * checks they describe the same wire values.
 */
import { v } from "convex/values";

import {
  externalIds,
  job,
  libraryKind,
  metadataOverrides,
  migrationSource,
  nullable,
  titleCard,
  titleKind,
} from "./validators";

/** Mirrors `MigrationPhase`. */
export const migrationPhase = v.union(
  v.literal("libraries"),
  v.literal("scanning"),
  v.literal("watchState"),
  v.literal("collections"),
  v.literal("overrides"),
  v.literal("done"),
);

/** Mirrors `MigrationCheckpoint`. */
export const migrationCheckpoint = v.object({
  phase: migrationPhase,
  unit: v.number(),
  cursor: v.number(),
});

/** Mirrors `MigrationImported`. */
export const migrationImported = v.object({
  librariesAdded: v.number(),
  watched: v.number(),
  inProgress: v.number(),
  playCounts: v.number(),
  favorites: v.number(),
  collections: v.number(),
  overrides: v.number(),
  keptLocal: v.number(),
  unmatched: v.number(),
});

/** Mirrors `PathMapping`. */
export const pathMapping = v.object({ from: v.string(), to: v.string() });

/** Mirrors `SealedCredentials`. */
export const sealedCredentials = v.object({
  version: v.literal(1),
  nonce: v.string(),
  ciphertext: v.string(),
});

/** Mirrors `PlannedUser`. */
const plannedUser = v.object({
  sourceUserId: v.string(),
  profileId: v.id("profiles"),
  history: v.union(v.literal("full"), v.literal("plays")),
});

/** Mirrors `PlannedLibrary`. */
const plannedLibrary = v.object({
  name: v.string(),
  kind: libraryKind,
  roots: v.array(v.string()),
});

/** Mirrors `StoredMigrationPlan`. */
export const storedMigrationPlan = v.object({
  sourceUrl: v.string(),
  serverId: v.string(),
  credentials: sealedCredentials,
  users: v.array(plannedUser),
  libraries: v.array(plannedLibrary),
  pathMappings: v.array(pathMapping),
});

/** Mirrors `MigrationTarget`. */
export const migrationTarget = v.object({
  userId: v.id("users"),
  name: v.string(),
  email: nullable(v.string()),
  profiles: v.array(v.object({ profileId: v.id("profiles"), name: v.string() })),
});

/** Mirrors `MigrationState`. */
export const migrationState = v.object({
  source: migrationSource,
  serverName: v.string(),
  plan: storedMigrationPlan,
  checkpoint: migrationCheckpoint,
  imported: migrationImported,
  libraryIds: v.array(v.id("libraries")),
});

/** Mirrors `MigrationRun`. */
export const migrationRun = v.object({
  job,
  source: migrationSource,
  serverName: v.string(),
  phase: migrationPhase,
  imported: migrationImported,
});

/** Mirrors `CatalogFile`. */
export const catalogFile = v.object({
  fileId: v.id("mediaFiles"),
  libraryId: v.id("libraries"),
  path: v.string(),
  missing: v.boolean(),
  titleId: v.id("titles"),
  kind: titleKind,
  externalIds,
  episodeId: nullable(v.id("episodes")),
  seasonNumber: nullable(v.number()),
  episodeNumber: nullable(v.number()),
});

/** Mirrors `LocalProgress`. */
export const localProgress = v.object({
  titleId: v.id("titles"),
  episodeId: nullable(v.id("episodes")),
  watched: v.boolean(),
  positionMs: v.number(),
  lastPlayedAt: v.number(),
});

/** Mirrors `WatchStateImport`. */
export const watchStateImport = v.object({
  profileId: v.id("profiles"),
  titleId: v.id("titles"),
  episodeId: nullable(v.id("episodes")),
  fileId: nullable(v.id("mediaFiles")),
  watched: v.boolean(),
  positionMs: v.number(),
  playCount: v.number(),
  lastPlayedAt: nullable(v.number()),
  favorite: v.boolean(),
});

/** Mirrors `WatchStateImported`. */
export const watchStateImported = v.object({
  watched: v.number(),
  inProgress: v.number(),
  playCounts: v.number(),
  favorites: v.number(),
  keptLocal: v.number(),
});

/** Mirrors `CollectionImport`. */
export const collectionImport = v.object({
  sourceKey: v.string(),
  name: v.string(),
  sortName: nullable(v.string()),
  titleIds: v.array(v.id("titles")),
});

/** Mirrors `OverrideImport`. */
export const overrideImport = v.object({
  titleId: v.id("titles"),
  overrides: metadataOverrides,
});

/** Mirrors `Collection` in `@movies/contracts/models/collections`. */
export const collection = v.object({
  id: v.id("collections"),
  name: v.string(),
  overview: nullable(v.string()),
  artwork: v.object({ poster: nullable(v.string()), backdrop: nullable(v.string()) }),
  titles: v.array(titleCard),
});
