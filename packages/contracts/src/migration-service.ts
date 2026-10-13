/**
 * The Convex functions a migration job calls, in `convex/migrationService.ts`. Like every media
 * service function they require the `media-service` scope; the job's writes also require the
 * job's lease, so a worker that lost it cannot write.
 */
import { Schema } from "effect";

import { mutation, query } from "./commands/command";
import { LibraryId, ProfileId } from "./ids";
import { NoArgs, Page, PageArgs } from "./models/common";
import { LibraryKind, LibraryRoot } from "./models/catalog";
import { JobProgress, QueuedJob } from "./models/jobs";
import { MigrationImported, PlannedLibraryAccess } from "./models/migration";
import {
  CatalogFile,
  COLLECTION_BATCH_LIMIT,
  COLLECTION_MEMBER_BATCH_LIMIT,
  CollectionImport,
  LocalProgress,
  MigrationCheckpoint,
  MigrationState,
  MigrationTarget,
  OverrideImport,
  StartMigrationArgs,
  WatchStateImport,
  WatchStateImported,
} from "./models/migration-service";
import { LeaseArgs, SCAN_BATCH_LIMIT } from "./models/scan";

const Batch = <Item extends Schema.Top>(item: Item) =>
  Schema.Array(item).check(Schema.isMaxLength(SCAN_BATCH_LIMIT));

/** Migration functions by name. */
export const migrationServiceFunctions = {
  "migrationService.targets": query({
    summary: "Accounts and profiles a migration can map source users to",
    group: "media-service",
    scope: "media-service",
    args: NoArgs,
    result: Schema.Array(MigrationTarget),
    function: "migrationService:targets",
  }),
  "migrationService.catalog": query({
    summary: "Known files with their titles' provider IDs, for matching source items",
    group: "media-service",
    scope: "media-service",
    args: Schema.Struct(PageArgs),
    result: Page(CatalogFile),
    function: "migrationService:catalog",
  }),
  "migrationService.localProgress": query({
    summary: "A profile's progress, for spotting conflicts in a dry run",
    group: "media-service",
    scope: "media-service",
    args: Schema.Struct({ profileId: ProfileId, ...PageArgs }),
    result: Page(LocalProgress),
    function: "migrationService:localProgress",
  }),
  "migrationService.start": mutation({
    summary: "Queue a migration job with its plan; returns the job already running for that server",
    group: "media-service",
    scope: "media-service",
    args: StartMigrationArgs,
    result: QueuedJob,
    function: "migrationService:start",
  }),
  "migrationService.state": query({
    summary: "A held migration job's plan and checkpoint",
    group: "media-service",
    scope: "media-service",
    args: Schema.Struct(LeaseArgs),
    result: MigrationState,
    function: "migrationService:state",
  }),
  "migrationService.saveCheckpoint": mutation({
    summary: "Record where a migration job resumes, what it imported, and its progress",
    group: "media-service",
    scope: "media-service",
    args: Schema.Struct({
      ...LeaseArgs,
      checkpoint: MigrationCheckpoint,
      imported: MigrationImported,
      progress: JobProgress,
    }),
    result: Schema.Struct({ cancelled: Schema.Boolean }),
    function: "migrationService:saveCheckpoint",
  }),
  "migrationService.ensureLibrary": mutation({
    summary: "Find the library covering these folders, or add one and queue its scan",
    group: "media-service",
    scope: "media-service",
    args: Schema.Struct({
      ...LeaseArgs,
      name: Schema.String,
      kind: LibraryKind,
      roots: Schema.Array(LibraryRoot).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
      /** Who sees the library if this call adds it; absent means admins only. */
      access: Schema.optionalKey(PlannedLibraryAccess),
    }),
    result: Schema.Struct({ libraryIds: Schema.Array(LibraryId), created: Schema.Boolean }),
    function: "migrationService:ensureLibrary",
  }),
  "migrationService.scansPending": query({
    summary: "How many of these libraries still have a scan queued or running",
    group: "media-service",
    scope: "media-service",
    args: Schema.Struct({ libraryIds: Schema.Array(LibraryId).check(Schema.isMaxLength(50)) }),
    result: Schema.Struct({ pending: Schema.Int }),
    function: "migrationService:scansPending",
  }),
  "migrationService.importWatchState": mutation({
    summary: "Import up to 100 matched watched marks, positions, play counts, and favorites",
    group: "media-service",
    scope: "media-service",
    args: Schema.Struct({ ...LeaseArgs, items: Batch(WatchStateImport) }),
    result: WatchStateImported,
    function: "migrationService:importWatchState",
  }),
  "migrationService.importCollections": mutation({
    summary: "Create or update up to 10 collections (2000 members) from a migration source",
    group: "media-service",
    scope: "media-service",
    args: Schema.Struct({
      ...LeaseArgs,
      items: Schema.Array(CollectionImport).check(
        Schema.isMaxLength(COLLECTION_BATCH_LIMIT),
        Schema.makeFilter(
          (items) =>
            items.reduce((total, item) => total + item.titleIds.length, 0) <=
              COLLECTION_MEMBER_BATCH_LIMIT ||
            `at most ${String(COLLECTION_MEMBER_BATCH_LIMIT)} members in all`,
        ),
      ),
    }),
    result: Schema.Struct({ imported: Schema.Int }),
    function: "migrationService:importCollections",
  }),
  "migrationService.importOverrides": mutation({
    summary: "Apply up to 100 matched titles' locked source metadata as overrides",
    group: "media-service",
    scope: "media-service",
    args: Schema.Struct({ ...LeaseArgs, items: Batch(OverrideImport) }),
    result: Schema.Struct({ imported: Schema.Int }),
    function: "migrationService:importOverrides",
  }),
};
