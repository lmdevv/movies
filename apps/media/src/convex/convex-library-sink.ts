/**
 * `LibrarySink` over Convex: the scanner's batches go to `mediaService:upsertScanned` and
 * `markMissing`, and the known files come from `mediaService:fileIndex`. Convex stores absolute
 * paths; this module converts them to and from paths relative to the scanned folder.
 *
 * Scan progress has no Convex function of its own: it travels with the scan job's lease renewal.
 * The sink keeps each library's latest progress for the job runner (`ScanProgress`).
 */
import type { LibraryId } from "@movies/contracts/ids";
import { Context, Effect, Layer, Option, Ref, Stream } from "effect";

import * as ArtworkKeys from "../artwork/artwork-keys.ts";
import * as LibrarySink from "../library/library-sink.ts";
import { absolutePath, relativeTo, toScannedItem } from "./catalog-records.ts";
import * as MediaBackend from "./media-backend.ts";

/** The latest progress of each library's running scan. */
export interface ProgressInterface {
  readonly latest: (libraryId: LibraryId) => Effect.Effect<Option.Option<LibrarySink.ScanProgress>>;
}

/** Scan progress as the sink last saw it, for job lease renewals. */
export class ScanProgress extends Context.Service<ScanProgress, ProgressInterface>()(
  "@movies/media/ScanProgress",
) {}

const failed =
  (operation: LibrarySink.LibrarySinkFailed["operation"]) =>
  (cause: unknown): LibrarySink.LibrarySinkFailed =>
    new LibrarySink.LibrarySinkFailed({ operation, cause });

/** Builds the sink and its progress board. */
const make = Effect.gen(function* () {
  const backend = yield* MediaBackend.Service;
  const keys = yield* ArtworkKeys.Service;
  const progress = yield* Ref.make<ReadonlyMap<LibraryId, LibrarySink.ScanProgress>>(new Map());

  const previousIndex = Effect.fn("ConvexLibrarySink.previousIndex")(function* (
    folder: LibrarySink.LibraryFolder,
  ) {
    const pages = Stream.paginate(Option.none<string>(), (cursor) =>
      backend
        .call("mediaService.fileIndex", {
          libraryId: folder.libraryId,
          cursor: Option.getOrNull(cursor),
          limit: 100,
        })
        .pipe(
          Effect.map(
            (page) =>
              [page.items, Option.map(Option.fromNullOr(page.nextCursor), Option.some)] as const,
          ),
        ),
    );

    const known = yield* Stream.runCollect(pages).pipe(Effect.mapError(failed("previousIndex")));

    return known.flatMap((file) =>
      Option.match(relativeTo(folder.root, file.path), {
        onNone: () => [],
        onSome: (relativePath) =>
          file.missing
            ? []
            : [{ relativePath, sizeBytes: file.sizeBytes, modifiedAtMs: file.mtimeMs }],
      }),
    );
  });

  const upsertBatch = Effect.fn("ConvexLibrarySink.upsertBatch")(function* (
    folder: LibrarySink.LibraryFolder,
    scanned: ReadonlyArray<LibrarySink.ScannedFile>,
  ) {
    const items = (yield* Effect.forEach(scanned, (file) =>
      toScannedItem(folder, file, keys.seal),
    )).flatMap((item) => (Option.isSome(item) ? [item.value] : []));

    if (items.length === 0) return;

    yield* backend
      .call("mediaService.upsertScanned", { libraryId: folder.libraryId, items })
      .pipe(Effect.mapError(failed("upsertBatch")));
  });

  const markMissing = Effect.fn("ConvexLibrarySink.markMissing")(function* (
    folder: LibrarySink.LibraryFolder,
    relativePaths: ReadonlyArray<string>,
  ) {
    yield* backend
      .call("mediaService.markMissing", {
        libraryId: folder.libraryId,
        paths: relativePaths.map((relativePath) => absolutePath(folder, relativePath)),
      })
      .pipe(Effect.mapError(failed("markMissing")));
  });

  const reportProgress = Effect.fn("ConvexLibrarySink.reportProgress")(function* (
    folder: LibrarySink.LibraryFolder,
    report: LibrarySink.ScanProgress,
  ) {
    yield* Ref.update(progress, (current) => new Map(current).set(folder.libraryId, report));
  });

  return Context.make(
    LibrarySink.Service,
    LibrarySink.Service.of({ previousIndex, upsertBatch, markMissing, reportProgress }),
  ).pipe(
    Context.add(
      ScanProgress,
      ScanProgress.of({
        latest: (libraryId) =>
          Ref.get(progress).pipe(
            Effect.map((current) => Option.fromUndefinedOr(current.get(libraryId))),
          ),
      }),
    ),
  );
});

/** The sink and its progress board over the Convex connection. */
export const layer: Layer.Layer<
  LibrarySink.Service | ScanProgress,
  never,
  MediaBackend.Service | ArtworkKeys.Service
> = Layer.effectContext(make);
