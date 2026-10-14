/**
 * Scrub thumbnails on disk, under `DATA_DIR/trickplay/<fileId>/<version>/`: the sprite sheets
 * (`0.jpg`, `1.jpg`, …) and `manifest.json`. Media files stay read-only; nothing is written next
 * to them. A new version is built in a hidden folder and renamed into place, so a reader never
 * sees half a set. Publishing keeps the file's other versions: two jobs for one file may both
 * publish, and only the catalog knows which one it accepted. The sweep removes what the catalog no
 * longer uses: thumbnails of files that are gone or missing, or of other contents.
 */
import { type TrickplayManifest, TrickplayVersion } from "@movies/contracts/trickplay";
import { Clock, Context, Duration, Effect, FileSystem, Layer, Option, Path, Schema } from "effect";

import * as MediaConfig from "../media-config.ts";

/** Thumbnails could not be written to the data folder. */
export class TrickplayStorageFailed extends Schema.TaggedError<TrickplayStorageFailed>()(
  "TrickplayStorageFailed",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Scrub thumbnails could not be stored in the data folder";
  }
}

/** Names that may appear in a version folder: the manifest and numbered sheets. */
const STORED_NAME = /^(?:manifest\.json|\d{1,5}\.jpg)$/u;

/** Folder names of media file IDs (Convex IDs are lowercase letters and digits). */
const FILE_ID = /^[0-9a-z]{1,64}$/u;

/** Hidden build folders start with this; they are never served and swept once stale. */
const BUILDING = ".building-";

/** Folders younger than this are left to the job that may still be recording them. */
const SWEEP_GRACE = Duration.hours(1);

/** File IDs the sweep asks the catalog about at once. */
const SWEEP_BATCH = 100;

const storageFailed = (cause: unknown) => new TrickplayStorageFailed({ cause });

const isTrickplayVersion = Schema.is(TrickplayVersion);

/** Whether a folder name is a version; a plain predicate, so the other branch keeps `string`. */
const isVersion = (name: string): boolean => isTrickplayVersion(name);

/** Stored thumbnails. */
export interface Interface {
  /**
   * The path of `name` (`manifest.json` or `<sheet>.jpg`) in a file's thumbnails at `version`, or
   * none when it is not stored. Names and IDs that could leave the folder are not stored.
   */
  readonly find: (
    fileId: string,
    version: string,
    name: string,
  ) => Effect.Effect<Option.Option<string>>;
  /**
   * Runs `build` in a fresh folder, writes the manifest it returns, and renames that folder into
   * place as `version`. The file's other versions stay for the sweep. A failed build leaves the
   * stored thumbnails as they were.
   */
  readonly publish: <E, R>(
    fileId: string,
    version: TrickplayVersion,
    build: (folder: string) => Effect.Effect<TrickplayManifest, E, R>,
  ) => Effect.Effect<TrickplayManifest, E | TrickplayStorageFailed, R>;
  /**
   * Removes the thumbnails `versions` no longer names: `versions` gets up to 100 stored file IDs
   * and answers the version each still uses (null for none). Returns how many folders went.
   */
  readonly sweep: <E>(
    versions: (
      fileIds: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyMap<string, TrickplayVersion | null>, E>,
  ) => Effect.Effect<number, E>;
}

/** The thumbnail store. */
export class Service extends Context.Service<Service, Interface>()(
  "@movies/media/TrickplayStore",
) {}

/** A store rooted at `root`. */
const make = Effect.fn("TrickplayStore.make")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const stored = (fileId: string, version: string, name: string): Option.Option<string> =>
    FILE_ID.test(fileId) && isVersion(version) && STORED_NAME.test(name)
      ? Option.some(path.join(root, fileId, version, name))
      : Option.none();

  const find = (fileId: string, version: string, name: string) =>
    Option.match(stored(fileId, version, name), {
      onNone: () => Effect.succeed(Option.none<string>()),
      onSome: (file) =>
        fs.exists(file).pipe(
          Effect.map((exists) => (exists ? Option.some(file) : Option.none())),
          Effect.orElseSucceed(() => Option.none<string>()),
        ),
    });

  const listing = (folder: string) => fs.readDirectory(folder).pipe(Effect.orElseSucceed(() => []));

  const removeQuietly = (folder: string) =>
    fs.remove(folder, { recursive: true, force: true }).pipe(
      Effect.tapError((error) => Effect.logWarning("TrickplayStore.remove_failed", error)),
      Effect.ignore,
    );

  const publish = <E, R>(
    fileId: string,
    version: TrickplayVersion,
    build: (folder: string) => Effect.Effect<TrickplayManifest, E, R>,
  ): Effect.Effect<TrickplayManifest, E | TrickplayStorageFailed, R> =>
    Effect.gen(function* () {
      if (!FILE_ID.test(fileId)) return yield* storageFailed(`Unexpected file ID ${fileId}`);
      const parent = path.join(root, fileId);
      const target = path.join(parent, version);
      const suffix = (yield* Clock.currentTimeNanos).toString(36);
      const building = path.join(parent, `${BUILDING}${version}-${suffix}`);

      yield* fs.makeDirectory(building, { recursive: true }).pipe(Effect.mapError(storageFailed));

      const manifest = yield* build(building).pipe(
        Effect.tap((built) =>
          fs
            .writeFileString(path.join(building, "manifest.json"), JSON.stringify(built))
            .pipe(Effect.mapError(storageFailed)),
        ),
        Effect.onError(() => removeQuietly(building)),
      );

      yield* removeQuietly(target);
      yield* fs.rename(building, target).pipe(
        Effect.mapError(storageFailed),
        Effect.onError(() => removeQuietly(building)),
      );

      return manifest;
    }).pipe(Effect.withSpan("TrickplayStore.publish"));

  /** Whether `folder` changed within the grace period, as a build being recorded may have. */
  const isRecent = (folder: string, now: number) =>
    fs.stat(folder).pipe(
      Effect.map((info) =>
        Option.match(info.mtime, {
          onNone: () => false,
          onSome: (mtime) => now - mtime.getTime() < Duration.toMillis(SWEEP_GRACE),
        }),
      ),
      Effect.orElseSucceed(() => true),
    );

  const sweep = <E>(
    versions: (
      fileIds: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyMap<string, TrickplayVersion | null>, E>,
  ): Effect.Effect<number, E> =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const fileIds = (yield* listing(root)).filter((name) => FILE_ID.test(name));

      const batches = Array.from({ length: Math.ceil(fileIds.length / SWEEP_BATCH) }, (_, index) =>
        fileIds.slice(index * SWEEP_BATCH, (index + 1) * SWEEP_BATCH),
      );

      const removed = yield* Effect.forEach(batches, (batch) =>
        Effect.gen(function* () {
          const keep = yield* versions(batch);

          const stale = yield* Effect.forEach(batch, (fileId) =>
            Effect.gen(function* () {
              const parent = path.join(root, fileId);
              const current = keep.get(fileId) ?? null;

              const candidates = (yield* listing(parent)).filter(
                (name) => name !== current && (isVersion(name) || name.startsWith(BUILDING)),
              );

              return yield* Effect.filter(
                candidates.map((name) => path.join(parent, name)),
                (folder) => Effect.map(isRecent(folder, now), (recent) => !recent),
              );
            }),
          );

          return stale.flat();
        }),
      );

      const folders = removed.flat();

      yield* Effect.forEach(folders, removeQuietly, { discard: true });

      return folders.length;
    }).pipe(Effect.withSpan("TrickplayStore.sweep"));

  return Service.of({ find, publish, sweep });
});

/** Thumbnails under `DATA_DIR/trickplay`. */
export const layer: Layer.Layer<
  Service,
  never,
  MediaConfig.Service | FileSystem.FileSystem | Path.Path
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* MediaConfig.Service;
    const path = yield* Path.Path;

    return yield* make(path.join(config.dataDir, "trickplay"));
  }),
);
