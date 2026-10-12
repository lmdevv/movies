/**
 * An in-memory file store implementing both `LibrarySink` and `FileResolver`, with an inspection
 * interface. Tests use it as a faithful store; standalone mode (no `CONVEX_URL`) serves the
 * approved library roots from it until the Convex integration replaces it.
 */
import { createHash } from "node:crypto";

import { MediaFileNotFound } from "@movies/contracts/media-playback";
import { Context, Effect, Layer, Ref } from "effect";

import { MediaFileId, type LibraryId } from "@movies/contracts/ids";
import * as FileResolver from "../playback/file-resolver.ts";
import * as LibrarySink from "./library-sink.ts";

/** One stored file. */
export interface StoredFile {
  readonly fileId: MediaFileId;
  readonly libraryId: LibraryId;
  readonly record: LibrarySink.ScannedFile;
  readonly missing: boolean;
}

/** Inspection and setup of the in-memory store. */
export interface Interface {
  /** Registers where a library lives so resolved paths can be made absolute. */
  readonly addLibrary: (libraryId: LibraryId, root: string) => Effect.Effect<void>;
  readonly files: (libraryId: LibraryId) => Effect.Effect<ReadonlyArray<StoredFile>>;
  readonly progress: (
    libraryId: LibraryId,
  ) => Effect.Effect<ReadonlyArray<LibrarySink.ScanProgress>>;
}

/** The in-memory library store. */
export class Service extends Context.Service<Service, Interface>()("@movies/media/MemoryLibrary") {}

interface State {
  readonly roots: ReadonlyMap<LibraryId, string>;
  readonly files: ReadonlyMap<MediaFileId, StoredFile>;
  readonly progress: ReadonlyMap<LibraryId, ReadonlyArray<LibrarySink.ScanProgress>>;
}

/** A stable file ID derived from the library and the path inside it. */
export const fileIdOf = (libraryId: LibraryId, relativePath: string): MediaFileId =>
  MediaFileId.make(
    createHash("sha256")
      .update(`${libraryId}\u0000${relativePath}`)
      .digest("base64url")
      .slice(0, 22),
  );

/** A fresh, empty store providing `LibrarySink`, `FileResolver`, and this inspection service. */
export const layer: Layer.Layer<Service | LibrarySink.Service | FileResolver.Service> =
  Layer.effectContext(
    Effect.gen(function* () {
      const state = yield* Ref.make<State>({
        roots: new Map(),
        files: new Map(),
        progress: new Map(),
      });

      const update = (change: (current: State) => Partial<State>) =>
        Ref.update(state, (current) => {
          const next = change(current);

          return {
            roots: next.roots ?? current.roots,
            files: next.files ?? current.files,
            progress: next.progress ?? current.progress,
          };
        });

      const filesOf = (current: State, libraryId: LibraryId): ReadonlyArray<StoredFile> =>
        [...current.files.values()].filter((file) => file.libraryId === libraryId);

      const sink = LibrarySink.Service.of({
        previousIndex: Effect.fn("MemoryLibrary.previousIndex")(function* (libraryId: LibraryId) {
          return filesOf(yield* Ref.get(state), libraryId)
            .filter((file) => !file.missing)
            .map((file) => ({
              relativePath: file.record.relativePath,
              sizeBytes: file.record.sizeBytes,
              modifiedAtMs: file.record.modifiedAtMs,
            }));
        }),
        upsertBatch: Effect.fn("MemoryLibrary.upsertBatch")(function* (libraryId, records) {
          yield* update((current) => {
            const files = new Map(current.files);

            for (const record of records) {
              const fileId = fileIdOf(libraryId, record.relativePath);
              files.set(fileId, { fileId, libraryId, record, missing: false });
            }

            return { files };
          });
        }),
        markMissing: Effect.fn("MemoryLibrary.markMissing")(function* (libraryId, relativePaths) {
          yield* update((current) => {
            const files = new Map(current.files);

            for (const relativePath of relativePaths) {
              const fileId = fileIdOf(libraryId, relativePath);
              const stored = files.get(fileId);

              if (stored !== undefined) files.set(fileId, { ...stored, missing: true });
            }

            return { files };
          });
        }),
        reportProgress: Effect.fn("MemoryLibrary.reportProgress")(function* (libraryId, report) {
          yield* update((current) => {
            const progress = new Map(current.progress);
            progress.set(libraryId, [...(current.progress.get(libraryId) ?? []), report]);

            return { progress };
          });
        }),
      });

      const resolver = FileResolver.Service.of({
        resolve: Effect.fn("MemoryLibrary.resolve")(function* (fileId: MediaFileId) {
          const current = yield* Ref.get(state);
          const stored = current.files.get(fileId);
          const root = stored === undefined ? undefined : current.roots.get(stored.libraryId);

          if (stored === undefined || stored.missing || root === undefined) {
            return yield* new MediaFileNotFound({ fileId });
          }

          const absolute = (relativePath: string) => `${root}/${relativePath}`;

          return {
            fileId,
            path: absolute(stored.record.relativePath),
            sizeBytes: stored.record.sizeBytes,
            modifiedAtMs: stored.record.modifiedAtMs,
            probe: stored.record.probe,
            subtitles: stored.record.subtitles.map((subtitle) => ({
              path: absolute(subtitle.path),
              format: subtitle.format,
              language: subtitle.language,
              title: subtitle.title,
              forced: subtitle.forced,
              hearingImpaired: subtitle.hearingImpaired,
              default: subtitle.default,
            })),
          } satisfies FileResolver.ResolvedMediaFile;
        }),
      });

      const inspection = Service.of({
        addLibrary: Effect.fn("MemoryLibrary.addLibrary")(function* (libraryId, root) {
          yield* update((current) => ({ roots: new Map(current.roots).set(libraryId, root) }));
        }),
        files: Effect.fn("MemoryLibrary.files")(function* (libraryId) {
          return filesOf(yield* Ref.get(state), libraryId);
        }),
        progress: Effect.fn("MemoryLibrary.progress")(function* (libraryId) {
          return (yield* Ref.get(state)).progress.get(libraryId) ?? [];
        }),
      });

      return Context.empty().pipe(
        Context.add(Service, inspection),
        Context.add(LibrarySink.Service, sink),
        Context.add(FileResolver.Service, resolver),
      );
    }),
  );
