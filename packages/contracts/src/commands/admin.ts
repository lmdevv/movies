/** Libraries, scans, jobs, metadata fixes, backups, and migration. */
import { Schema } from "effect";

import { BackupId, JobId, LibraryId, TitleId } from "../ids";
import {
  LibraryAccess,
  LibraryDetail,
  LibraryFile,
  LibraryFileFilter,
  LibraryFileSummary,
  LibraryKind,
  LibraryRoot,
  MetadataCandidate,
  MetadataField,
  MetadataOverrides,
} from "../models/catalog";
import { DisplayName, NoArgs, Ok, Page, PageArgs } from "../models/common";
import { Backup, Job, JobKind, JobStatus, QueuedJob, ScanMode } from "../models/jobs";
import {
  MigrationConnectArgs,
  MigrationConnectResult,
  MigrationDryRunResult,
  MigrationImportResult,
  MigrationPlanArgs,
  MigrationRun,
} from "../models/migration";
import { media, mutation, query } from "./command";

const Roots = Schema.Array(LibraryRoot).check(Schema.isMinLength(1), Schema.isMaxLength(20));

/** Library administration and scans. */
export const libraryCommands = {
  "libraries.listDetails": query({
    summary: "List every library with its folders and access",
    group: "libraries",
    scope: "manage",
    args: NoArgs,
    result: Schema.Array(LibraryDetail),
    function: "libraries:listDetails",
  }),
  "libraries.get": query({
    summary: "Show a library's folders and access",
    group: "libraries",
    scope: "manage",
    args: Schema.Struct({ libraryId: LibraryId }),
    result: LibraryDetail,
    function: "libraries:get",
  }),
  "libraries.create": mutation({
    summary: "Add a library folder and scan it",
    group: "libraries",
    scope: "manage",
    args: Schema.Struct({
      name: DisplayName,
      kind: LibraryKind,
      roots: Roots,
      access: Schema.optionalKey(LibraryAccess),
    }),
    result: Schema.Struct({ libraryId: LibraryId, jobId: JobId }),
    function: "libraries:create",
  }),
  "libraries.update": mutation({
    summary: "Rename a library or change its folders or access",
    group: "libraries",
    scope: "manage",
    args: Schema.Struct({
      libraryId: LibraryId,
      name: Schema.optionalKey(DisplayName),
      roots: Schema.optionalKey(Roots),
      access: Schema.optionalKey(LibraryAccess),
    }),
    result: LibraryDetail,
    function: "libraries:update",
  }),
  "libraries.remove": mutation({
    summary: "Remove a library from [movies]; files on disk are untouched",
    group: "libraries",
    scope: "manage",
    args: Schema.Struct({ libraryId: LibraryId }),
    result: Ok,
    function: "libraries:remove",
  }),
  "libraries.files": query({
    summary: "List a library's files with their titles, or only missing or unmatched ones",
    group: "libraries",
    scope: "manage",
    args: Schema.Struct({
      libraryId: LibraryId,
      ...PageArgs,
      filter: Schema.optionalKey(LibraryFileFilter),
      /** Only this title's files; the filter is ignored. */
      titleId: Schema.optionalKey(TitleId),
    }),
    result: Page(LibraryFile),
    function: "libraries:files",
  }),
  "libraries.fileSummary": query({
    summary: "Count a library's missing files and unmatched titles",
    group: "libraries",
    scope: "manage",
    args: Schema.Struct({ libraryId: LibraryId }),
    result: LibraryFileSummary,
    function: "libraries:fileSummary",
  }),
  "libraries.scan": mutation({
    summary: "Scan a library for new, changed, and missing files",
    group: "libraries",
    scope: "manage",
    args: Schema.Struct({ libraryId: LibraryId, mode: Schema.optionalKey(ScanMode) }),
    result: QueuedJob,
    function: "libraries:scan",
  }),
  "jobs.list": query({
    summary: "List recent background jobs",
    group: "jobs",
    scope: "manage",
    args: Schema.Struct({
      kind: Schema.optionalKey(JobKind),
      status: Schema.optionalKey(JobStatus),
      limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
    }),
    result: Schema.Array(Job),
    function: "jobs:list",
  }),
  "jobs.get": query({
    summary: "Show a background job's progress",
    group: "jobs",
    scope: "manage",
    args: Schema.Struct({ jobId: JobId }),
    result: Job,
    function: "jobs:get",
  }),
  "jobs.cancel": mutation({
    summary: "Cancel a pending or running job",
    group: "jobs",
    scope: "manage",
    args: Schema.Struct({ jobId: JobId }),
    result: Ok,
    function: "jobs:cancel",
  }),
};

/** Metadata matching and overrides. */
export const metadataCommands = {
  "metadata.searchCandidates": media({
    summary: "Search the metadata provider for matches for a title",
    group: "metadata",
    scope: "manage",
    args: Schema.Struct({
      titleId: TitleId,
      query: Schema.Trimmed.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
      year: Schema.optionalKey(Schema.Int),
    }),
    result: Schema.Array(MetadataCandidate),
    route: { method: "POST", path: "/api/metadata/candidates" },
  }),
  "metadata.fixMatch": mutation({
    summary: "Match a title to a metadata provider entry",
    group: "metadata",
    scope: "manage",
    args: Schema.Struct({
      titleId: TitleId,
      provider: Schema.Literal("tmdb"),
      providerId: Schema.Trimmed.check(Schema.isMinLength(1)),
    }),
    result: QueuedJob,
    function: "metadata:fixMatch",
  }),
  "metadata.refresh": mutation({
    summary: "Refresh a title's metadata from its current match",
    group: "metadata",
    scope: "manage",
    args: Schema.Struct({ titleId: TitleId }),
    result: QueuedJob,
    function: "metadata:refresh",
  }),
  "metadata.edit": mutation({
    summary: "Override or clear a title's name, year, overview, or rating",
    group: "metadata",
    scope: "manage",
    args: Schema.Struct({
      titleId: TitleId,
      set: MetadataOverrides,
      clear: Schema.optionalKey(Schema.Array(MetadataField)),
    }),
    result: Ok,
    function: "metadata:edit",
  }),
};

/** Backups, restore, and migration from Jellyfin or Plex. */
export const maintenanceCommands = {
  "backups.list": query({
    summary: "List backups",
    group: "backups",
    scope: "admin",
    args: NoArgs,
    result: Schema.Array(Backup),
    function: "backups:list",
  }),
  "backups.run": mutation({
    summary: "Back up the database now",
    group: "backups",
    scope: "admin",
    args: NoArgs,
    result: QueuedJob,
    function: "backups:run",
  }),
  "backups.restore": media({
    summary: "Restore the database from a backup; every session signs in again",
    group: "backups",
    scope: "admin",
    args: Schema.Struct({ backupId: BackupId }),
    result: Ok,
    route: { method: "POST", path: "/api/backups/restore" },
  }),
  "migration.connect": media({
    summary: "Connect to a Jellyfin or Plex server to migrate from",
    group: "migration",
    scope: "admin",
    args: MigrationConnectArgs,
    result: MigrationConnectResult,
    route: { method: "POST", path: "/api/migration/connect" },
  }),
  "migration.dryRun": media({
    summary: "Preview what a migration would import without writing anything",
    group: "migration",
    scope: "admin",
    args: MigrationPlanArgs,
    result: MigrationDryRunResult,
    route: { method: "POST", path: "/api/migration/dry-run" },
  }),
  "migration.import": media({
    summary: "Import libraries, watch history, favorites, collections, and metadata overrides",
    group: "migration",
    scope: "admin",
    args: MigrationPlanArgs,
    result: MigrationImportResult,
    route: { method: "POST", path: "/api/migration/import" },
  }),
  "migration.status": query({
    summary: "Show migration jobs, their phase, and what they imported",
    group: "migration",
    scope: "admin",
    args: NoArgs,
    result: Schema.Array(MigrationRun),
    function: "migration:status",
  }),
};
