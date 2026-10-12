/**
 * The Convex functions the media service calls after signing in with `MEDIA_SERVICE_API_KEY`
 * through the `apikey` provider. Each requires the `media-service` scope, which no user session can
 * hold, and user sessions cannot call them. Convex never calls the media service; it subscribes to
 * `pendingJobs`, `libraries`, and `endedSessions` and writes back through these mutations.
 */
import { Schema } from "effect";

import { mutation, query } from "./commands/command";
import { BackupId, LibraryId, MediaFileId, PlaybackSessionId, TitleId } from "./ids";
import { migrationServiceFunctions } from "./migration-service";
import { NoArgs, Ok, Page, PageArgs } from "./models/common";
import { BACKUP_SYNC_LIMIT, BackupArchive, Job, JobProgress } from "./models/jobs";
import { PlaybackMode } from "./models/playback";
import {
  ClaimedJob,
  EndedSession,
  IndexedFile,
  LeaseArgs,
  LeaseMs,
  MediaLibrary,
  MetadataTarget,
  ResolvedFile,
  SCAN_BATCH_LIMIT,
  ScannedEpisode,
  ScannedItem,
  ScannedTitle,
  SessionStatus,
  UpsertedFile,
} from "./models/scan";
import { Bytes, EpochMillis } from "./units";

const Batch = <Item extends Schema.Top>(item: Item) =>
  Schema.Array(item).check(Schema.isMaxLength(SCAN_BATCH_LIMIT));

/** Media service functions by name. */
export const mediaServiceFunctions = {
  "mediaService.pendingJobs": query({
    summary: "Jobs waiting for a worker, oldest first",
    group: "media-service",
    scope: "media-service",
    args: NoArgs,
    result: Schema.Array(Job),
    function: "mediaService:pendingJobs",
  }),
  "mediaService.claimJob": mutation({
    summary: "Claim a pending job, or one whose lease expired; null when another worker holds it",
    group: "media-service",
    scope: "media-service",
    args: Schema.Struct({ ...LeaseArgs, leaseMs: LeaseMs }),
    result: Schema.NullOr(ClaimedJob),
    function: "mediaService:claimJob",
  }),
  "mediaService.renewLease": mutation({
    summary: "Extend a held lease and report progress; `cancelled` tells the worker to stop",
    group: "media-service",
    scope: "media-service",
    args: Schema.Struct({
      ...LeaseArgs,
      leaseMs: LeaseMs,
      progress: Schema.optionalKey(JobProgress),
    }),
    result: Schema.Struct({ leaseExpiresAt: EpochMillis, cancelled: Schema.Boolean }),
    function: "mediaService:renewLease",
  }),
  "mediaService.completeJob": mutation({
    summary: "Finish a held job successfully",
    group: "media-service",
    scope: "media-service",
    args: Schema.Struct({ ...LeaseArgs, message: Schema.optionalKey(Schema.String) }),
    result: Ok,
    function: "mediaService:completeJob",
  }),
  "mediaService.failJob": mutation({
    summary: "Fail a held job, or return it to the queue when `retry` is set",
    group: "media-service",
    scope: "media-service",
    args: Schema.Struct({ ...LeaseArgs, error: Schema.String, retry: Schema.Boolean }),
    result: Ok,
    function: "mediaService:failJob",
  }),
  "mediaService.libraries": query({
    summary: "Every library and its folders",
    group: "media-service",
    scope: "media-service",
    args: NoArgs,
    result: Schema.Array(MediaLibrary),
    function: "mediaService:libraries",
  }),
  "mediaService.fileIndex": query({
    summary: "Known files of a library, by path, for skipping unchanged files",
    group: "media-service",
    scope: "media-service",
    args: Schema.Struct({ libraryId: LibraryId, ...PageArgs }),
    result: Page(IndexedFile),
    function: "mediaService:fileIndex",
  }),
  "mediaService.upsertScanned": mutation({
    summary: "Insert or update up to 100 scanned files with their titles and episodes",
    group: "media-service",
    scope: "media-service",
    args: Schema.Struct({ libraryId: LibraryId, items: Batch(ScannedItem) }),
    result: Schema.Array(UpsertedFile),
    function: "mediaService:upsertScanned",
  }),
  "mediaService.markMissing": mutation({
    summary: "Mark up to 100 paths missing; watch history that points at them stays",
    group: "media-service",
    scope: "media-service",
    args: Schema.Struct({ libraryId: LibraryId, paths: Batch(Schema.String) }),
    result: Schema.Struct({ marked: Schema.Int }),
    function: "mediaService:markMissing",
  }),
  "mediaService.resolveFile": query({
    summary: "The path, folders, and probe of a file named in a playback token",
    group: "media-service",
    scope: "media-service",
    args: Schema.Struct({ fileId: MediaFileId }),
    result: ResolvedFile,
    function: "mediaService:resolveFile",
  }),
  "mediaService.sessionStatus": query({
    summary: "Whether a playback session is still active",
    group: "media-service",
    scope: "media-service",
    args: Schema.Struct({ sessionId: PlaybackSessionId }),
    result: SessionStatus,
    function: "mediaService:sessionStatus",
  }),
  "mediaService.endedSessions": query({
    summary: "Playback sessions that ended after `after`, oldest first",
    group: "media-service",
    scope: "media-service",
    args: Schema.Struct({
      after: EpochMillis,
      limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
    }),
    result: Schema.Array(EndedSession),
    function: "mediaService:endedSessions",
  }),
  "mediaService.recordPlaybackMode": mutation({
    summary: "Record how a session's file reaches its device",
    group: "media-service",
    scope: "media-service",
    args: Schema.Struct({ sessionId: PlaybackSessionId, mode: PlaybackMode }),
    result: Ok,
    function: "mediaService:recordPlaybackMode",
  }),
  "mediaService.metadataTarget": query({
    summary: "What a metadata job should look up",
    group: "media-service",
    scope: "media-service",
    args: Schema.Struct({ titleId: TitleId }),
    result: MetadataTarget,
    function: "mediaService:metadataTarget",
  }),
  "mediaService.applyMetadata": mutation({
    summary: "Write fetched metadata for a title and up to 100 of its episodes",
    group: "media-service",
    scope: "media-service",
    args: Schema.Struct({
      ...LeaseArgs,
      titleId: TitleId,
      title: ScannedTitle,
      episodes: Batch(ScannedEpisode),
    }),
    result: Ok,
    function: "mediaService:applyMetadata",
  }),
  "mediaService.recordBackup": mutation({
    summary: "Record a finished backup archive",
    group: "media-service",
    scope: "media-service",
    args: Schema.Struct({
      ...LeaseArgs,
      fileName: Schema.String,
      sizeBytes: Bytes,
    }),
    result: Schema.Struct({ backupId: BackupId }),
    function: "mediaService:recordBackup",
  }),
  "mediaService.backupFile": query({
    summary: "The archive file of a backup, for a restore",
    group: "media-service",
    scope: "media-service",
    args: Schema.Struct({ backupId: BackupId }),
    result: Schema.Struct({ fileName: Schema.String }),
    function: "mediaService:backupFile",
  }),
  "mediaService.syncBackups": mutation({
    summary: "Make the backups table list exactly the archives in the backup folder",
    group: "media-service",
    scope: "media-service",
    args: Schema.Struct({
      archives: Schema.Array(BackupArchive).check(Schema.isMaxLength(BACKUP_SYNC_LIMIT)),
    }),
    result: Schema.Struct({ added: Schema.Int, removed: Schema.Int }),
    function: "mediaService:syncBackups",
  }),
  ...migrationServiceFunctions,
};

/** The media service functions' type. */
export type MediaServiceFunctions = typeof mediaServiceFunctions;
