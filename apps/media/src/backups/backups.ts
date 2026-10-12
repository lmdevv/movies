/**
 * Database backups and restores. A backup runs `convex export --include-file-storage` into a
 * hidden partial file in `BACKUP_DIR` and renames it into place only when the export succeeded, so
 * the folder never holds a truncated archive under an archive name. Archives are private to the
 * service user (`0600` in a `0700` folder): they hold every account's password hash.
 *
 * Retention runs only after a new backup succeeded and never removes that backup. The Convex
 * `backups` table mirrors the folder: `sync` makes it list exactly the archives on disk, after
 * pruning, after a restore (whose snapshot carries an older table), and at startup.
 *
 * A restore (`restore`) follows the procedure in `docs/operations.md`: `convex import
 * --replace-all` of an archive inside `BACKUP_DIR`, then re-registering this service's key (the
 * snapshot's `apiKeys` table may hold another deployment's), settling the jobs the snapshot caught
 * mid-run, and ending every session (a snapshot carries the sessions it was taken with). One backup or restore runs at a time.
 */
import { createHash } from "node:crypto";

import type { BackupId } from "@movies/contracts/ids";
import type { BackupArchive } from "@movies/contracts/models/jobs";
import type { CallError } from "@movies/sdk/effect";
import {
  Clock,
  Context,
  Effect,
  FileSystem,
  Layer,
  Match,
  Option,
  Path,
  type PlatformError,
  Redacted,
  Schedule,
  Schema,
  Semaphore,
} from "effect";

import * as MediaBackend from "../convex/media-backend.ts";
import * as MediaConfig from "../media-config.ts";
import * as Archives from "./backup-archives.ts";
import * as ConvexCli from "./convex-cli.ts";

/** Another backup or restore is running. */
class BackupBusy extends Schema.TaggedError<BackupBusy>()("BackupBusy", {}) {
  override get message(): string {
    return "Backup busy: another backup or restore is running; try again when it finished";
  }
}

/** The backup folder could not be read or written. */
class BackupFolderFailed extends Schema.TaggedError<BackupFolderFailed>()("BackupFolderFailed", {
  operation: Schema.Literals(["prepare", "list", "finish", "remove", "resolve"]),
  /** A path-free label, such as `missing` or `permission denied`. */
  reason: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Backup folder failed: could not ${this.operation} (${this.reason}); check BACKUP_DIR and its permissions`;
  }
}

/** The archive of a backup is not a regular file inside `BACKUP_DIR`. */
class BackupArchiveMissing extends Schema.TaggedError<BackupArchiveMissing>()(
  "BackupArchiveMissing",
  { fileName: Schema.String },
) {
  override get message(): string {
    return `Backup archive missing: ${this.fileName} is not in the backup folder`;
  }
}

/** Failures of taking a backup. */
export type CreateError = BackupBusy | BackupFolderFailed | ConvexCli.ConvexCliError;

/** Failures of a restore. */
type RestoreError =
  | BackupBusy
  | BackupArchiveMissing
  | BackupFolderFailed
  | ConvexCli.ConvexCliError
  | CallError;

/** Backups of the Convex deployment. */
export interface Interface {
  /** Exports the deployment into a new archive and returns it. */
  readonly create: (trigger: Archives.BackupTrigger) => Effect.Effect<BackupArchive, CreateError>;
  /**
   * Removes archives older than the retention, except `keep`, then syncs the table; returns the
   * removed file names.
   */
  readonly prune: (
    keep: string,
  ) => Effect.Effect<ReadonlyArray<string>, BackupFolderFailed | CallError>;
  /** Makes the Convex `backups` table list exactly the archives in the folder. */
  readonly sync: Effect.Effect<void, BackupFolderFailed | CallError>;
  /** Replaces the whole database with a backup, then ends every session. */
  readonly restore: (backupId: BackupId) => Effect.Effect<void, RestoreError>;
}

/** Database backups. */
export class Service extends Context.Service<Service, Interface>()("@movies/media/Backups") {}

const folderFailed =
  (operation: BackupFolderFailed["operation"]) => (cause: PlatformError.PlatformError) =>
    new BackupFolderFailed({
      operation,
      reason: Match.value(cause.reason).pipe(
        Match.tag("NotFound", () => "missing"),
        Match.tag("PermissionDenied", () => "permission denied"),
        Match.tag("AlreadyExists", () => "already exists"),
        Match.orElse(() => "unreadable"),
      ),
      cause,
    });

/** A function result the CLI printed, on one line for the log. */
const compact = (printed: string): string => printed.replaceAll(/\s+/gu, "");

/** Builds the service; one permit serializes backups and restores. */
const make = Effect.gen(function* () {
  const config = yield* MediaConfig.Service;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cli = yield* ConvexCli.Service;
  const backend = yield* MediaBackend.Service;
  const permit = yield* Semaphore.make(1);
  const folder = config.backupDir;

  /** Runs `effect` holding the permit, or fails at once when another backup or restore holds it. */
  const exclusively = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E | BackupBusy> =>
    Semaphore.withPermitsIfAvailable(
      permit,
      1,
    )(effect).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new BackupBusy()),
          onSome: Effect.succeed,
        }),
      ),
    );

  const prepareFolder = Effect.gen(function* () {
    yield* fs.makeDirectory(folder, { recursive: true });
    yield* fs.chmod(folder, 0o700);
  }).pipe(Effect.mapError(folderFailed("prepare")));

  /** Every archive in the folder; partial exports and other files are skipped. */
  const listArchives = Effect.gen(function* () {
    const names = yield* fs.readDirectory(folder);

    const archives = yield* Effect.forEach(
      names.filter(Archives.isArchiveName),
      (name) =>
        fs
          .stat(path.join(folder, name))
          .pipe(
            Effect.map((info) =>
              info.type === "File"
                ? Option.some(
                    Archives.describeArchive(
                      name,
                      Number(info.size),
                      Option.match(info.mtime, { onNone: () => 0, onSome: (at) => at.getTime() }),
                    ),
                  )
                : Option.none(),
            ),
          ),
      { concurrency: 8 },
    );

    return archives.flatMap(Option.toArray);
  }).pipe(Effect.mapError(folderFailed("list")));

  /** Deletes partial exports a crashed backup left behind. */
  const removePartials = Effect.gen(function* () {
    const names = yield* fs.readDirectory(folder);

    yield* Effect.forEach(
      names.filter(Archives.isPartial),
      (name) => fs.remove(path.join(folder, name), { force: true }),
      { discard: true },
    );
  }).pipe(Effect.mapError(folderFailed("remove")));

  const sync = Effect.gen(function* () {
    const archives = yield* listArchives;
    const result = yield* backend.call("mediaService.syncBackups", { archives });

    if (result.added > 0 || result.removed > 0) {
      yield* Effect.logInfo("Backups.synced").pipe(
        Effect.annotateLogs({ added: result.added, removed: result.removed }),
      );
    }
  }).pipe(Effect.withSpan("Backups.sync"));

  const create = Effect.fn("Backups.create")(
    function* (trigger: Archives.BackupTrigger) {
      yield* prepareFolder;
      yield* removePartials;
      const takenAt = yield* Clock.currentTimeMillis;
      const fileName = Archives.archiveName(trigger, takenAt);
      const partial = path.join(folder, Archives.partialName(fileName));
      const final = path.join(folder, fileName);

      yield* Effect.gen(function* () {
        yield* cli.exportSnapshot(partial);

        yield* Effect.gen(function* () {
          yield* fs.chmod(partial, 0o600);
          yield* fs.rename(partial, final);
        }).pipe(Effect.mapError(folderFailed("finish")));
      }).pipe(Effect.onError(() => fs.remove(partial, { force: true }).pipe(Effect.ignore)));

      const info = yield* fs.stat(final).pipe(Effect.mapError(folderFailed("finish")));
      const archive = Archives.describeArchive(fileName, Number(info.size), takenAt);

      yield* Effect.logInfo("Backups.created").pipe(
        Effect.annotateLogs({ fileName, sizeBytes: archive.sizeBytes, trigger }),
      );

      return archive;
    },
    (effect, trigger) =>
      exclusively(effect).pipe(Effect.withSpan("Backups.backup", { attributes: { trigger } })),
  );

  const prune = Effect.fn("Backups.prune")(function* (keep: string) {
    const now = yield* Clock.currentTimeMillis;
    const archives = yield* listArchives;

    const expired = Archives.expiredArchives(archives, now, config.backupRetention, keep);

    yield* Effect.forEach(
      expired,
      (archive) =>
        fs
          .remove(path.join(folder, archive.fileName), { force: true })
          .pipe(Effect.mapError(folderFailed("remove"))),
      { discard: true },
    );

    yield* sync;

    return expired.map((archive) => archive.fileName);
  });

  /** The real path of `fileName` when it is a regular file directly inside the folder. */
  const archivePath = Effect.fnUntraced(function* (fileName: string) {
    if (!Archives.isArchiveName(fileName)) return yield* new BackupArchiveMissing({ fileName });
    const missing = () => new BackupArchiveMissing({ fileName });
    const realFolder = yield* fs.realPath(folder).pipe(Effect.mapError(folderFailed("resolve")));
    const real = yield* fs.realPath(path.join(folder, fileName)).pipe(Effect.mapError(missing));
    const info = yield* fs.stat(real).pipe(Effect.mapError(missing));

    if (path.dirname(real) !== realFolder || info.type !== "File") return yield* missing();

    return real;
  });

  const serviceKey = Option.map(config.mediaServiceApiKey, (key) => {
    const value = Redacted.value(key);

    return { hash: createHash("sha256").update(value).digest("hex"), prefix: value.slice(0, 10) };
  });

  const restore = Effect.fn("Backups.restore")(function* (backupId: BackupId) {
    const { fileName } = yield* backend.call("mediaService.backupFile", { backupId });
    const archive = yield* archivePath(fileName);

    yield* exclusively(
      Effect.gen(function* () {
        yield* Effect.logWarning("Backups.restore_started").pipe(Effect.annotateLogs({ fileName }));

        yield* cli.importSnapshot(archive);

        // The snapshot's `apiKeys` may not hold this service's key; register it before the
        // service signs in again.
        if (Option.isSome(serviceKey)) yield* cli.run("setup:ensureServiceKey", serviceKey.value);

        // The snapshot was taken while its backup job ran; settle that job and any other.
        const settled = yield* cli.run("maintenance:settleRestoredJobs", {});
        const ended = yield* cli.run("maintenance:endAllSessions", {});

        yield* Effect.logWarning("Backups.restored").pipe(
          Effect.annotateLogs({ fileName, jobs: compact(settled), sessions: compact(ended) }),
        );
      }),
    );

    // The data is back; listing the archives again only corrects the table.
    yield* sync.pipe(
      Effect.retry(Schedule.exponential("1 second").pipe(Schedule.upTo({ times: 5 }))),
      Effect.catch((error) => Effect.logWarning("Backups.sync_after_restore_failed", error)),
    );
  });

  return Service.of({ create, prune, sync, restore });
});

/** The backups service. */
export const layer: Layer.Layer<
  Service,
  never,
  MediaConfig.Service | FileSystem.FileSystem | Path.Path | ConvexCli.Service | MediaBackend.Service
> = Layer.effect(Service, make);

/**
 * Syncs the backups table with the folder once Convex is reachable after startup, so archives a
 * restore or an admin left behind show up. Retries with backoff for a few minutes.
 */
export const layerSyncOnStart: Layer.Layer<never, never, Service> = Layer.effectDiscard(
  Effect.gen(function* () {
    const backups = yield* Service;

    yield* backups.sync.pipe(
      Effect.retry(Schedule.exponential("2 seconds").pipe(Schedule.upTo({ times: 8 }))),
      Effect.catch((error) => Effect.logWarning("Backups.startup_sync_failed", error)),
      Effect.forkScoped,
    );
  }),
);
