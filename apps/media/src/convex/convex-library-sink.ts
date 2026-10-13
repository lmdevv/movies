/**
 * `LibrarySink` over Convex: the scanner's batches go to `mediaService:upsertScanned` and
 * `markMissing`, and the known files come from `mediaService:fileIndex`. Convex stores absolute
 * paths; this module converts them to and from paths relative to the scanned folder.
 *
 * Scan progress has no Convex function of its own: it travels with the scan job's lease renewal.
 * The sink keeps each library's latest progress for the job runner (`ScanProgress`).
 */
import type { LibraryId } from "@movies/contracts/ids";
import type { UpsertedFile } from "@movies/contracts/models/scan";
import { Context, Effect, Layer, Option, Ref, Stream } from "effect";

import * as ArtworkKeys from "../artwork/artwork-keys.ts";
import * as LibrarySink from "../library/library-sink.ts";
import {
  absolutePath,
  digestOf,
  relativeTo,
  toScannedCollection,
  toScannedCredits,
  toScannedItem,
} from "./catalog-records.ts";
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

/** Credit and collection writes in flight at once during a scan. */
const DETAIL_CONCURRENCY = 8;

/** Titles and episodes whose last write digest the sink remembers before starting over. */
const SENT_CAPACITY = 50_000;

/** Builds the sink and its progress board. */
const make = Effect.gen(function* () {
  const backend = yield* MediaBackend.Service;
  const keys = yield* ArtworkKeys.Service;
  const progress = yield* Ref.make<ReadonlyMap<LibraryId, LibrarySink.ScanProgress>>(new Map());

  /**
   * What this scan sent per title or episode, so it writes a show's credits once rather than once
   * per episode file. It starts empty with every scan (`previousIndex`), because a metadata
   * refresh may have changed what Convex holds since; Convex compares digests itself.
   */
  const sent = new Map<string, string>();

  const previousIndex = Effect.fn("ConvexLibrarySink.previousIndex")(function* (
    folder: LibrarySink.LibraryFolder,
  ) {
    sent.clear();

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

  /**
   * Sends `write` unless Convex already stores `digest` (`stored`) or this scan already sent it
   * for `key`. The key is marked before the write, so concurrent writes of one batch send once;
   * a failed write unmarks it for the next scan.
   */
  const once = <E>(
    key: string,
    digest: string,
    stored: string | null,
    write: Effect.Effect<unknown, E>,
  ) =>
    Effect.suspend(() => {
      if (stored === digest || sent.get(key) === digest) return Effect.void;

      if (sent.size >= SENT_CAPACITY) sent.clear();
      sent.set(key, digest);

      return write.pipe(
        Effect.tapError(() => Effect.sync(() => sent.delete(key))),
        Effect.asVoid,
      );
    });

  /** Credits and the collection of each title (and episode) a batch touched. */
  const writeDetails = Effect.fn("ConvexLibrarySink.writeDetails")(function* (
    folder: LibrarySink.LibraryFolder,
    written: ReadonlyArray<{
      readonly file: LibrarySink.ScannedFile;
      readonly upserted: UpsertedFile;
    }>,
  ) {
    const writes = yield* Effect.forEach(written, ({ file, upserted }) =>
      Effect.gen(function* () {
        if (file.title === undefined) return [];
        const titleCredits = yield* toScannedCredits(folder, file.title.credits, keys.seal);
        const collection = yield* toScannedCollection(folder, file.title.collection, keys.seal);
        const titleHash = digestOf(titleCredits);
        const collectionHash = digestOf(collection);

        const titleWrites = [
          once(
            `credits:${upserted.titleId}`,
            titleHash,
            upserted.titleCreditsHash,
            backend.call("mediaService.applyCredits", {
              titleId: upserted.titleId,
              episodeId: null,
              credits: titleCredits,
              hash: titleHash,
            }),
          ),
          once(
            `collection:${upserted.titleId}`,
            collectionHash,
            upserted.collectionHash,
            backend.call("mediaService.applyCollection", {
              titleId: upserted.titleId,
              collection,
              hash: collectionHash,
            }),
          ),
        ];

        if (file.episode === undefined || upserted.episodeId === null) return titleWrites;
        const episodeCredits = yield* toScannedCredits(folder, file.episode.credits, keys.seal);
        const episodeHash = digestOf(episodeCredits);

        // An episode without credits that never had any needs no write either.
        const stored =
          upserted.episodeCreditsHash ?? (episodeCredits.length === 0 ? episodeHash : null);

        return [
          ...titleWrites,
          once(
            `credits:${upserted.episodeId}`,
            episodeHash,
            stored,
            backend.call("mediaService.applyCredits", {
              titleId: upserted.titleId,
              episodeId: upserted.episodeId,
              credits: episodeCredits,
              hash: episodeHash,
            }),
          ),
        ];
      }),
    );

    yield* Effect.forEach(writes.flat(), (write) => write, {
      concurrency: DETAIL_CONCURRENCY,
      discard: true,
    });
  });

  const upsertBatch = Effect.fn("ConvexLibrarySink.upsertBatch")(function* (
    folder: LibrarySink.LibraryFolder,
    scanned: ReadonlyArray<LibrarySink.ScannedFile>,
  ) {
    const prepared = yield* Effect.forEach(scanned, (file) =>
      toScannedItem(folder, file, keys.seal).pipe(
        Effect.map(Option.map((item) => ({ file, item }))),
      ),
    );

    const items = prepared.flatMap((entry) => (Option.isSome(entry) ? [entry.value] : []));

    if (items.length === 0) return;

    const upserted = yield* backend
      .call("mediaService.upsertScanned", {
        libraryId: folder.libraryId,
        items: items.map((entry) => entry.item),
      })
      .pipe(Effect.mapError(failed("upsertBatch")));

    // Credits and collections are extras: the files are stored, so a failed extra is logged and
    // written again by the next scan of the title, without failing this one.
    yield* writeDetails(
      folder,
      items.flatMap((entry, index) => {
        const result = upserted[index];

        return result === undefined ? [] : [{ file: entry.file, upserted: result }];
      }),
    ).pipe(
      Effect.catch((error) =>
        Effect.logWarning("ConvexLibrarySink.details_failed", error.message).pipe(
          Effect.annotateLogs({ libraryId: folder.libraryId }),
        ),
      ),
    );
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
