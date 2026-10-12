/** Background jobs the media service claims with a lease: scans, metadata refreshes, backups, and migrations. */
import { Schema } from "effect";

import { BackupId, JobId, LibraryId, TitleId, UserId } from "../ids";
import { Bytes, EpochMillis } from "../units";

/** What a job does. */
export const JobKind = Schema.Literals(["scan", "metadata", "backup", "migration"]);

/** What a job does. */
export type JobKind = typeof JobKind.Type;

/** Where a job stands. A `running` job whose lease expired returns to `pending`. */
export const JobStatus = Schema.Literals([
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);

/** Where a job stands. */
export type JobStatus = typeof JobStatus.Type;

/** A scan walks every root (`full`) or only checks known paths for changes (`quick`). */
export const ScanMode = Schema.Literals(["full", "quick"]);

/** Which migration source a job reads. */
export const MigrationSource = Schema.Literals(["jellyfin", "plex"]);

/** Which migration source a job reads. */
export type MigrationSource = typeof MigrationSource.Type;

/** What the worker needs to run a job, by kind. */
export const JobPayload = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("scan"),
    libraryId: LibraryId,
    mode: ScanMode,
  }),
  Schema.Struct({
    kind: Schema.Literal("metadata"),
    titleId: TitleId,
    /** A manual match chosen by an admin; null refreshes from the current match. */
    match: Schema.NullOr(
      Schema.Struct({ provider: Schema.Literal("tmdb"), providerId: Schema.String }),
    ),
  }),
  Schema.Struct({
    kind: Schema.Literal("backup"),
    trigger: Schema.Literals(["nightly", "manual"]),
  }),
  Schema.Struct({
    kind: Schema.Literal("migration"),
    source: MigrationSource,
    serverName: Schema.String,
  }),
]);

/** What the worker needs to run a job. */
export type JobPayload = typeof JobPayload.Type;

/** Progress the worker reports while it holds the lease. */
export const JobProgress = Schema.Struct({
  done: Schema.Int,
  total: Schema.NullOr(Schema.Int),
  message: Schema.NullOr(Schema.String),
});

/** Job progress. */
export interface JobProgress extends Schema.Schema.Type<typeof JobProgress> {}

/** A job as admins see it. */
export const Job = Schema.Struct({
  id: JobId,
  kind: JobKind,
  status: JobStatus,
  payload: JobPayload,
  progress: JobProgress,
  error: Schema.NullOr(Schema.String),
  requestedBy: Schema.NullOr(UserId),
  attempts: Schema.Int,
  createdAt: EpochMillis,
  startedAt: Schema.NullOr(EpochMillis),
  finishedAt: Schema.NullOr(EpochMillis),
});

/** A job. */
export interface Job extends Schema.Schema.Type<typeof Job> {}

/** The result of a command that queued a job. */
export const QueuedJob = Schema.Struct({ jobId: JobId });

/** A backup archive in the media host's backup folder. */
export const Backup = Schema.Struct({
  id: BackupId,
  fileName: Schema.String,
  sizeBytes: Bytes,
  trigger: Schema.Literals(["nightly", "manual"]),
  createdAt: EpochMillis,
});

/** A backup archive. */
export interface Backup extends Schema.Schema.Type<typeof Backup> {}
