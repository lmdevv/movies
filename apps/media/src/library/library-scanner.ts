/**
 * Scans one library folder: walks it, skips files whose size and modification time did not
 * change, probes the rest with bounded concurrency, reads local NFO files, artwork, and sidecar
 * subtitles, enriches titles through the metadata resolver, and sends the results to the
 * `LibrarySink` in batches. It never writes inside a library folder.
 *
 * Safety rules:
 * - The root must be inside one of the approved `LIBRARY_ROOTS`.
 * - Symbolic links are followed only when their target stays inside the root; others are
 *   counted as rejected and skipped. Directory loops are visited once.
 * - An unreadable root or folder fails the scan instead of marking files missing, and a root
 *   that is suddenly empty while the store knows files (an unmounted share) is reported as
 *   unavailable. Files are marked missing only after a complete walk.
 */
import {
  Cache,
  Context,
  Effect,
  FileSystem,
  Layer,
  Match,
  Option,
  Path,
  type PlatformError,
  Schema,
  Stream,
} from "effect";

import type { LibraryId } from "../ids.ts";
import * as MediaConfig from "../media-config.ts";
import { probeFile } from "../media/media-probe.ts";
import * as MediaTools from "../media/media-tools.ts";
import * as MetadataResolver from "../metadata/title-metadata.ts";
import { type EntryKind, errorCode, listEntries } from "../platform/node-directories.ts";
import {
  episodeThumb,
  type FolderListing,
  movieArtwork,
  seasonPoster,
  showArtwork,
} from "./artwork.ts";
import * as LibrarySink from "./library-sink.ts";
import { MediaName, parseMediaPath } from "./media-naming.ts";

type MovieName = Extract<MediaName, { readonly _tag: "Movie" }>;

type EpisodeName = Extract<MediaName, { readonly _tag: "Episode" }>;

import { type LocalMetadata, type NfoKind, parseNfo } from "./nfo.ts";
import { sidecarSubtitles } from "./sidecar-subtitles.ts";

/** How much of a library a scan re-reads. */
type ScanMode = "incremental" | "full";

/** One scan of one library folder. */
interface ScanRequest {
  readonly libraryId: LibraryId;
  /** Absolute path of the library folder. */
  readonly root: string;
  /** `incremental` skips unchanged files; `full` re-reads every file, for example after NFO edits. */
  readonly mode: ScanMode;
}

/** A file the scan could not read. */
interface ScanFailure {
  readonly relativePath: string;
  readonly reason: string;
}

/** What a finished scan did. */
interface ScanSummary {
  readonly libraryId: LibraryId;
  readonly discovered: number;
  readonly unchanged: number;
  readonly processed: number;
  readonly failed: number;
  readonly missing: number;
  /** Symbolic links skipped because they point outside the library root. */
  readonly rejectedLinks: number;
  /** The first failures, for diagnostics. */
  readonly failures: ReadonlyArray<ScanFailure>;
}

/** The library folder is not inside an approved `LIBRARY_ROOTS` entry. */
export class LibraryRootNotApproved extends Schema.TaggedError<LibraryRootNotApproved>()(
  "LibraryRootNotApproved",
  { root: Schema.String },
) {
  override get message(): string {
    return `Library root not approved: ${this.root} is outside LIBRARY_ROOTS`;
  }
}

/** The library folder cannot be read right now. Its files are not marked missing. */
export class LibraryRootUnavailable extends Schema.TaggedError<LibraryRootUnavailable>()(
  "LibraryRootUnavailable",
  {
    root: Schema.String,
    reason: Schema.Literals([
      "missing",
      "not-a-directory",
      "permission-denied",
      "unreadable",
      "empty",
    ]),
  },
) {
  override get message(): string {
    return `Library root unavailable: ${this.root} (${this.reason}); known files were left untouched`;
  }
}

/** A folder inside the library cannot be read. The scan stops so no file is marked missing. */
class LibraryFolderUnreadable extends Schema.TaggedError<LibraryFolderUnreadable>()(
  "LibraryFolderUnreadable",
  { folder: Schema.String, code: Schema.String },
) {
  override get message(): string {
    return `Library folder unreadable: ${this.folder === "" ? "(root)" : this.folder} (${this.code}); known files were left untouched`;
  }
}

/** Failures that stop a scan. */
type ScanError =
  | LibraryRootNotApproved
  | LibraryRootUnavailable
  | LibraryFolderUnreadable
  | LibrarySink.LibrarySinkFailed;

/** Scans libraries. */
export interface Interface {
  readonly scan: (request: ScanRequest) => Effect.Effect<ScanSummary, ScanError>;
}

/** The library scanner. */
export class Service extends Context.Service<Service, Interface>()(
  "@movies/media/LibraryScanner",
) {}

const PROBE_CONCURRENCY = 8;

const STAT_CONCURRENCY = 16;

const WALK_CONCURRENCY = 4;

const BATCH_SIZE = 100;

const MAX_REPORTED_FAILURES = 50;

const MEDIA_EXTENSIONS: ReadonlySet<string> = new Set([
  "mkv",
  "mp4",
  "m4v",
  "mov",
  "avi",
  "webm",
  "ts",
  "m2ts",
  "mts",
  "wmv",
  "mpg",
  "mpeg",
  "flv",
  "ogv",
]);

/** Folders that file systems, NAS appliances, and desktops create for themselves. */
const SKIPPED_FOLDERS: ReadonlySet<string> = new Set([
  "lost+found",
  "@eadir",
  "#recycle",
  "#snapshot",
  "$recycle.bin",
  "system volume information",
]);

const isMediaFile = (name: string): boolean =>
  MEDIA_EXTENSIONS.has(name.split(".").at(-1)?.toLowerCase() ?? "");

const isSkipped = (name: string): boolean =>
  name.startsWith(".") || SKIPPED_FOLDERS.has(name.toLowerCase());

const parentOf = (relativePath: string): string => relativePath.split("/").slice(0, -1).join("/");

const stemOf = (relativePath: string): string =>
  (relativePath.split("/").at(-1) ?? relativePath).replace(/\.[^.]+$/, "");

const join = (folder: string, name: string): string => (folder === "" ? name : `${folder}/${name}`);

const isWithin = (root: string, candidate: string, separator: string): boolean =>
  candidate === root ||
  candidate.startsWith(root.endsWith(separator) ? root : `${root}${separator}`);

const SEASON_FOLDER = /^(?:season|series|staffel|saison|s)[ ._-]*\d{1,3}$|^specials?$/i;

interface WalkResult {
  readonly folders: ReadonlyMap<string, ReadonlyArray<string>>;
  readonly media: ReadonlyArray<string>;
  readonly rejectedLinks: number;
}

interface StatResult {
  readonly relativePath: string;
  readonly sizeBytes: number;
  readonly modifiedAtMs: number;
}

/** A short, path-free label for a file system failure. */
const platformReason = (
  error: PlatformError.PlatformError,
): "missing" | "permission-denied" | "unreadable" =>
  Match.value(error.reason).pipe(
    Match.tag("NotFound", () => "missing" as const),
    Match.tag("PermissionDenied", () => "permission-denied" as const),
    Match.orElse(() => "unreadable" as const),
  );

const kindOfTarget = (type: FileSystem.File.Type): EntryKind =>
  Match.value(type).pipe(
    Match.when("Directory", () => "directory" as const),
    Match.when("File", () => "file" as const),
    Match.orElse(() => "other" as const),
  );

const isMainVideo =
  (folder: string) =>
  (name: string): boolean =>
    isMediaFile(name) && !MediaName.guards.Extra(parseMediaPath(join(folder, name)));

/** Title and episode metadata of one file; both absent for extras. */
interface Described {
  readonly title: MetadataResolver.TitleMetadata | undefined;
  readonly episode: MetadataResolver.EpisodeMetadata | undefined;
}

/** Mutable counters owned by one scan; snapshots are what the sink sees. */
interface Counters {
  discovered: number;
  unchanged: number;
  processed: number;
  failed: number;
  missing: number;
}

/** Builds the scanner. */
const make = Effect.gen(function* () {
  const config = yield* MediaConfig.Service;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sink = yield* LibrarySink.Service;
  const resolver = yield* MetadataResolver.Service;
  const tools = yield* MediaTools.Service;

  /** The canonical root, after checking it is approved and readable. */
  const openRoot = Effect.fn("LibraryScanner.openRoot")(function* (root: string) {
    const realRoot = yield* fs
      .realPath(root)
      .pipe(
        Effect.mapError(
          (error) => new LibraryRootUnavailable({ root, reason: platformReason(error) }),
        ),
      );

    const approved = yield* Effect.forEach(config.libraryRoots, (approvedRoot) =>
      fs.realPath(approvedRoot).pipe(Effect.option),
    );

    const isApproved = approved.some(
      (candidate) => Option.isSome(candidate) && isWithin(candidate.value, realRoot, path.sep),
    );

    if (!isApproved) return yield* new LibraryRootNotApproved({ root });

    const info = yield* fs
      .stat(realRoot)
      .pipe(Effect.mapError(() => new LibraryRootUnavailable({ root, reason: "unreadable" })));

    if (info.type !== "Directory") {
      return yield* new LibraryRootUnavailable({ root, reason: "not-a-directory" });
    }

    return realRoot;
  });

  const walk = Effect.fn("LibraryScanner.walk")(function* (root: string, realRoot: string) {
    const folders = new Map<string, ReadonlyArray<string>>();
    const media: Array<string> = [];
    const visited = new Set<string>();
    let rejectedLinks = 0;

    /** What `child` is, following a symbolic link only when it stays inside the root. */
    const resolveEntry = Effect.fnUntraced(function* (child: string, kind: EntryKind) {
      if (kind !== "symlink") return kind;
      const target = yield* fs.realPath(path.join(root, child)).pipe(Effect.option);

      if (Option.isNone(target)) return "other" as const;

      if (!isWithin(realRoot, target.value, path.sep)) {
        rejectedLinks += 1;

        yield* Effect.logWarning("LibraryScanner.link_rejected").pipe(
          Effect.annotateLogs({ relativePath: child }),
        );

        return "other" as const;
      }

      const info = yield* fs.stat(target.value).pipe(Effect.option);

      return Option.match(info, {
        onNone: () => "other" as const,
        onSome: (stat) => kindOfTarget(stat.type),
      });
    });

    const visit = (relative: string): Effect.Effect<void, LibraryFolderUnreadable> =>
      Effect.gen(function* () {
        const absolute = relative === "" ? root : path.join(root, relative);
        const real = yield* fs.realPath(absolute).pipe(Effect.option);

        if (Option.isNone(real) || visited.has(real.value)) return;
        visited.add(real.value);

        const entries = yield* Effect.tryPromise({
          try: () => listEntries(absolute),
          catch: (cause) =>
            new LibraryFolderUnreadable({ folder: relative, code: errorCode(cause) }),
        }).pipe(
          // A folder deleted mid-walk is simply gone; anything else stops the scan.
          Effect.asSome,
          Effect.catchIf(
            (error) => relative !== "" && error.code === "ENOENT",
            () => Effect.succeedNone,
          ),
        );

        if (Option.isNone(entries)) return;

        folders.set(
          relative,
          entries.value.map((entry) => entry.name),
        );

        const subfolders: Array<string> = [];

        for (const entry of entries.value) {
          if (isSkipped(entry.name)) continue;
          const child = join(relative, entry.name);
          const kind = yield* resolveEntry(child, entry.kind);

          if (kind === "directory") subfolders.push(child);
          else if (kind === "file" && isMediaFile(entry.name)) media.push(child);
        }

        yield* Effect.forEach(subfolders, visit, { concurrency: WALK_CONCURRENCY, discard: true });
      });

    yield* visit("");

    return { folders, media: media.toSorted(), rejectedLinks } satisfies WalkResult;
  });

  const scan = Effect.fn("LibraryScanner.scan")(
    function* (request: ScanRequest) {
      const { libraryId, root } = request;
      const realRoot = yield* openRoot(root);

      const previous = new Map(
        (yield* sink.previousIndex(libraryId)).map((file) => [file.relativePath, file]),
      );

      const counters: Counters = {
        discovered: 0,
        unchanged: 0,
        processed: 0,
        failed: 0,
        missing: 0,
      };

      const failures: Array<ScanFailure> = [];

      const report = (phase: LibrarySink.ScanProgress["phase"]) =>
        sink.reportProgress(libraryId, {
          phase,
          discovered: counters.discovered,
          unchanged: counters.unchanged,
          processed: counters.processed,
          failed: counters.failed,
          missing: counters.missing,
        });

      yield* report("walking");
      const walked = yield* walk(root, realRoot);

      if (walked.media.length === 0 && previous.size > 0) {
        return yield* new LibraryRootUnavailable({ root, reason: "empty" });
      }

      counters.discovered = walked.media.length;
      yield* report("processing");

      const listing = (folder: string): FolderListing => ({
        folder,
        names: walked.folders.get(folder) ?? [],
      });

      const absolute = (relativePath: string): string =>
        path.join(root, ...relativePath.split("/"));

      const nfoCache = yield* Cache.make({
        capacity: 10_000,
        lookup: ([relativePath, kind, episode]: readonly [string, NfoKind, number | undefined]) =>
          fs.readFileString(absolute(relativePath)).pipe(
            Effect.map((text) => Option.fromNullishOr(parseNfo(text, kind, episode))),
            Effect.orElseSucceed(() => Option.none<LocalMetadata>()),
          ),
      });

      /** Reads the first NFO among `candidates` that exists in `folder`. */
      const readNfo = (
        folder: string,
        candidates: ReadonlyArray<string>,
        kind: NfoKind,
        episode?: number,
      ) => {
        const byLowerName = new Map(
          listing(folder).names.map((name) => [name.toLowerCase(), name]),
        );

        const found = candidates
          .map((candidate) => byLowerName.get(candidate.toLowerCase()))
          .find((name) => name !== undefined);

        return found === undefined
          ? Effect.succeedNone
          : Cache.get(nfoCache, [join(folder, found), kind, episode] as const);
      };

      const showCache = yield* Cache.make({
        capacity: 10_000,
        lookup: ([showFolder, showTitle, showYear, tvdb, tmdb, imdb]: readonly [
          string | undefined,
          string,
          number | undefined,
          string | undefined,
          string | undefined,
          string | undefined,
        ]) =>
          Effect.gen(function* () {
            const local =
              showFolder === undefined
                ? Option.none()
                : yield* readNfo(showFolder, ["tvshow.nfo"], "show");

            return yield* resolver.title({
              kind: "show",
              title: showTitle,
              year: showYear,
              nameIds: { tvdb, tmdb, imdb },
              local: Option.getOrUndefined(local),
              artwork: showFolder === undefined ? {} : showArtwork(listing(showFolder)),
            });
          }),
      });

      const describeMovie = Effect.fn("LibraryScanner.describeMovie")(function* (
        relativePath: string,
        name: MovieName,
      ) {
        const folder = parentOf(relativePath);
        const stem = stemOf(relativePath);

        const ownFolder =
          folder !== "" && listing(folder).names.filter(isMainVideo(folder)).length === 1;

        const local = yield* readNfo(
          folder,
          ownFolder ? [`${stem}.nfo`, "movie.nfo"] : [`${stem}.nfo`],
          "movie",
        );

        const resolved = yield* resolver.title({
          kind: "movie",
          title: name.title,
          year: name.year,
          nameIds: name.ids,
          local: Option.getOrUndefined(local),
          artwork: movieArtwork(relativePath, listing(folder), ownFolder),
        });

        return { title: resolved.metadata, episode: undefined };
      });

      const describeEpisode = Effect.fn("LibraryScanner.describeEpisode")(function* (
        relativePath: string,
        name: EpisodeName,
      ) {
        const folder = parentOf(relativePath);
        const inSeasonFolder = SEASON_FOLDER.test(folder.split("/").at(-1) ?? "");
        const showFolderPath = inSeasonFolder ? parentOf(folder) : folder;
        const showFolder = showFolderPath === "" ? undefined : showFolderPath;

        const show = yield* Cache.get(showCache, [
          showFolder,
          name.showTitle,
          name.showYear,
          name.showIds.tvdb,
          name.showIds.tmdb,
          name.showIds.imdb,
        ] as const);

        const local = yield* readNfo(
          folder,
          [`${stemOf(relativePath)}.nfo`],
          "episode",
          name.episodes[0],
        );

        const episode = yield* resolver.episode(show.providerId, {
          name,
          local: Option.getOrUndefined(local),
          still: episodeThumb(relativePath, listing(folder)),
          seasonPoster:
            showFolder === undefined
              ? undefined
              : seasonPoster(
                  name.season,
                  listing(showFolder),
                  inSeasonFolder ? listing(folder) : undefined,
                ),
        });

        return { title: show.metadata, episode };
      });

      const describe = (relativePath: string, name: MediaName): Effect.Effect<Described> =>
        MediaName.match(name, {
          Movie: (movie) => describeMovie(relativePath, movie),
          Episode: (episode) => describeEpisode(relativePath, episode),
          Extra: () => Effect.succeed<Described>({ title: undefined, episode: undefined }),
        });

      const fail = (relativePath: string, reason: string) =>
        Effect.gen(function* () {
          counters.failed += 1;

          if (failures.length < MAX_REPORTED_FAILURES) failures.push({ relativePath, reason });

          yield* Effect.logWarning("LibraryScanner.file_failed").pipe(
            Effect.annotateLogs({ relativePath, reason }),
          );
        });

      const statFile = (relativePath: string) =>
        fs.stat(absolute(relativePath)).pipe(
          Effect.map((info): StatResult => ({
            relativePath,
            sizeBytes: Number(info.size),
            modifiedAtMs: Option.match(info.mtime, {
              onNone: () => 0,
              onSome: (date) => date.getTime(),
            }),
          })),
          Effect.asSome,
          Effect.catch((error) =>
            fail(relativePath, platformReason(error)).pipe(Effect.as(Option.none<StatResult>())),
          ),
        );

      const isUnchanged = (file: StatResult): boolean => {
        const known = previous.get(file.relativePath);

        return (
          request.mode === "incremental" &&
          known !== undefined &&
          known.sizeBytes === file.sizeBytes &&
          known.modifiedAtMs === file.modifiedAtMs
        );
      };

      const processFile = (file: StatResult) =>
        Effect.gen(function* () {
          const probe = yield* probeFile(absolute(file.relativePath)).pipe(
            Effect.provideService(MediaTools.Service, tools),
          );

          const name = parseMediaPath(file.relativePath);
          const described = yield* describe(file.relativePath, name);

          const scanned: LibrarySink.ScannedFile = {
            relativePath: file.relativePath,
            sizeBytes: file.sizeBytes,
            modifiedAtMs: file.modifiedAtMs,
            name,
            probe,
            subtitles: sidecarSubtitles(file.relativePath, listing(parentOf(file.relativePath))),
            title: described.title,
            episode: described.episode,
          };

          return Option.some(scanned);
        }).pipe(
          Effect.catchTags({
            MediaToolFailed: (error) =>
              fail(file.relativePath, `ffprobe exited with ${String(error.exitCode)}`).pipe(
                Effect.as(Option.none<LibrarySink.ScannedFile>()),
              ),
            MediaProbeInvalid: () =>
              fail(file.relativePath, "ffprobe output was not a media description").pipe(
                Effect.as(Option.none<LibrarySink.ScannedFile>()),
              ),
          }),
        );

      const skipUnchanged = Effect.sync(() => {
        counters.unchanged += 1;

        return Option.none<LibrarySink.ScannedFile>();
      });

      yield* Stream.fromIterable(walked.media).pipe(
        Stream.mapEffect(statFile, { concurrency: STAT_CONCURRENCY }),
        Stream.filter(Option.isSome),
        Stream.map((stat) => stat.value),
        Stream.mapEffect((file) => (isUnchanged(file) ? skipUnchanged : processFile(file)), {
          concurrency: PROBE_CONCURRENCY,
          unordered: true,
        }),
        Stream.filter(Option.isSome),
        Stream.map((scanned) => scanned.value),
        Stream.grouped(BATCH_SIZE),
        Stream.runForEach((batch) =>
          Effect.gen(function* () {
            yield* sink.upsertBatch(libraryId, batch);
            counters.processed += batch.length;
            yield* report("processing");
          }),
        ),
      );

      const present = new Set(walked.media);
      const missing = [...previous.keys()].filter((relativePath) => !present.has(relativePath));

      counters.missing = missing.length;
      yield* report("reconciling");

      yield* Effect.forEach(
        Array.from({ length: Math.ceil(missing.length / BATCH_SIZE) }, (_, index) =>
          missing.slice(index * BATCH_SIZE, (index + 1) * BATCH_SIZE),
        ),
        (batch) => sink.markMissing(libraryId, batch),
        { discard: true },
      );

      yield* report("done");

      return {
        libraryId,
        discovered: counters.discovered,
        unchanged: counters.unchanged,
        processed: counters.processed,
        failed: counters.failed,
        missing: counters.missing,
        rejectedLinks: walked.rejectedLinks,
        failures,
      } satisfies ScanSummary;
    },
    (effect, request) => effect.pipe(Effect.annotateLogs({ libraryId: request.libraryId })),
  );

  return Service.of({ scan });
});

/** The scanner with its dependencies left open for composition. */
export const layer: Layer.Layer<
  Service,
  never,
  | MediaConfig.Service
  | FileSystem.FileSystem
  | Path.Path
  | LibrarySink.Service
  | MetadataResolver.Service
  | MediaTools.Service
> = Layer.effect(Service, make);
