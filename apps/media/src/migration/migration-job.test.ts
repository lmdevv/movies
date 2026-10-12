import {
  EpisodeId,
  JobId,
  LibraryId,
  MediaFileId,
  ProfileId,
  TitleId,
} from "@movies/contracts/ids";
import type { MigrationImported } from "@movies/contracts/models/migration";
import type {
  CatalogFile,
  MigrationCheckpoint,
  StoredMigrationPlan,
  WatchStateImport,
} from "@movies/contracts/models/migration-service";
import { TransportError } from "@movies/sdk/effect";
import { assert, layer } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Predicate, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";

import { testConfigLayer } from "../testing/test-config.ts";
import { sealCredentials } from "./credentials.ts";
import * as MigrationBackend from "./migration-backend.ts";
import { runMigrationJob } from "./migration-job.ts";
import { credentialsBinding } from "./migrations.ts";
import {
  FIXTURE_API_KEY,
  jellyfinRecording,
  startJellyfinFixture,
} from "./testing/jellyfin-fixture.ts";

const SERVICE_KEY = "test-media-service-key";

/** The recorded server's own ID (`GET /System/Info/Public`). */
const SERVER_ID = "237573b6a39f4aa0bd5d95be34d5f5f9";

const ADMIN = ProfileId.make("profile-admin");

const BOB = ProfileId.make("profile-bob");

const LEASE = { jobId: JobId.make("job-1"), workerId: "worker-1" };

const NO_IDS = { tmdb: null, imdb: null, tvdb: null };

const MOVIES = "/mnt/nas/movies";

const SHOWS = "/mnt/nas/shows";

const SHOW_FOLDER = `${SHOWS}/Fixture Show (2021)`;

const movie = (title: string, path: string): CatalogFile => ({
  fileId: MediaFileId.make(`file-${title}`),
  libraryId: LibraryId.make("movies"),
  path: `${MOVIES}/${path}`,
  missing: false,
  titleId: TitleId.make(title),
  kind: "movie",
  externalIds: NO_IDS,
  episodeId: null,
  seasonNumber: null,
  episodeNumber: null,
});

const episode = (number: number, path: string): CatalogFile => ({
  fileId: MediaFileId.make(`file-show-${String(number)}`),
  libraryId: LibraryId.make("shows"),
  path: `${SHOW_FOLDER}/${path}`,
  missing: false,
  titleId: TitleId.make("show"),
  kind: "show",
  externalIds: NO_IDS,
  episodeId: EpisodeId.make(`show-1-${String(number)}`),
  seasonNumber: 1,
  episodeNumber: number,
});

/** The fixture library as [movies] scanned it, under `/mnt/nas`. */
const CATALOG: ReadonlyArray<CatalogFile> = [
  movie("big-buck", "Big Buck Fixture (2008)/Big Buck Fixture (2008).mp4"),
  movie("remux", "Remux Fixture (2015)/Remux Fixture (2015).mkv"),
  episode(1, "Season 01/Fixture Show - S01E01 - Pilot.mkv"),
  episode(2, "Season 01/Fixture Show - S01E02 - Second.mkv"),
];

const NOTHING: MigrationImported = {
  librariesAdded: 0,
  watched: 0,
  inProgress: 0,
  playCounts: 0,
  favorites: 0,
  collections: 0,
  overrides: 0,
  keptLocal: 0,
  unmatched: 0,
};

const planFor = (sourceUrl: string): StoredMigrationPlan => ({
  sourceUrl,
  serverId: SERVER_ID,
  credentials: sealCredentials(
    Redacted.make(SERVICE_KEY),
    { kind: "token", token: Redacted.make(FIXTURE_API_KEY) },
    credentialsBinding(SERVER_ID, sourceUrl),
  ),
  users: [
    { sourceUserId: jellyfinRecording.ids["admin"] ?? "", profileId: ADMIN, history: "full" },
    { sourceUserId: jellyfinRecording.ids["bob"] ?? "", profileId: BOB, history: "full" },
  ],
  libraries: [
    { name: "Movies", kind: "movies", roots: [MOVIES] },
    { name: "Shows", kind: "shows", roots: [SHOWS] },
  ],
  pathMappings: [{ from: "/media", to: "/mnt/nas" }],
});

/** What the in-memory Convex holds. */
interface Stored {
  readonly progress: Map<string, WatchStateImport>;
  readonly myList: Set<string>;
  readonly collections: Map<string, ReadonlyArray<string>>;
  readonly overrides: Map<string, string>;
  readonly libraries: Map<string, LibraryId>;
  checkpoint: MigrationCheckpoint;
  imported: MigrationImported;
  /** Every import call, in order: its kind and how many items it carried. */
  readonly writes: Array<readonly [string, number]>;
}

/** Fault and observation hooks for one backend. */
interface Hooks {
  /** Fails the checkpoint with this number (1-based) as if Convex were unreachable. */
  readonly failCheckpoint?: number;
  /** Answers `cancelled` from the checkpoint with this number (1-based). */
  readonly cancelAtCheckpoint?: number;
  readonly cancelled?: Deferred.Deferred<void>;
}

const progressKey = (item: WatchStateImport) =>
  `${item.profileId}|${item.titleId}|${item.episodeId ?? ""}`;

/**
 * An in-memory `MigrationBackend` with the Convex functions' idempotency: progress keyed by
 * profile and item, My List by profile and title, collections by source key, and overrides by
 * title, so writing a batch again changes nothing.
 */
const inMemoryBackend = (sourceUrl: string, stored: Stored, hooks: Hooks = {}) => {
  let checkpoints = 0;

  const unused = Effect.die(new Error("Not used by the migration job"));

  const backend: MigrationBackend.Interface = {
    targets: unused,
    localProgress: () => unused,
    start: () => unused,
    libraries: Effect.succeed([]),
    catalog: Effect.succeed(CATALOG),
    state: () =>
      Effect.succeed({
        source: "jellyfin" as const,
        serverName: "jellyfin-fixture",
        plan: planFor(sourceUrl),
        checkpoint: stored.checkpoint,
        imported: stored.imported,
        libraryIds: [...stored.libraries.values()],
      }),
    saveCheckpoint: (_lease, checkpoint, imported) =>
      Effect.gen(function* () {
        checkpoints += 1;

        if (checkpoints === hooks.failCheckpoint) {
          return yield* new TransportError({
            operation: "migrationService.saveCheckpoint",
            message: "Convex went away",
            cause: null,
          });
        }

        stored.checkpoint = checkpoint;
        stored.imported = imported;

        if (checkpoints !== hooks.cancelAtCheckpoint) return false;

        if (hooks.cancelled !== undefined) yield* Deferred.succeed(hooks.cancelled, undefined);

        return true;
      }),
    ensureLibrary: (_lease, library) =>
      Effect.sync(() => {
        const key = library.roots.join(",");
        const existing = stored.libraries.get(key);
        const libraryId = existing ?? LibraryId.make(`library-${library.name}`);

        stored.libraries.set(key, libraryId);

        return { libraryIds: [libraryId], created: existing === undefined };
      }),
    scansPending: () => Effect.succeed(0),
    importWatchState: (_lease, items) =>
      Effect.sync(() => {
        stored.writes.push(["watchState", items.length]);

        for (const item of items) {
          stored.progress.set(progressKey(item), item);

          if (item.favorite) stored.myList.add(`${item.profileId}|${item.titleId}`);
        }

        return { watched: 0, inProgress: 0, playCounts: 0, favorites: 0, keptLocal: 0 };
      }),
    importCollections: (_lease, items) =>
      Effect.sync(() => {
        stored.writes.push(["collections", items.length]);

        for (const item of items) stored.collections.set(item.sourceKey, item.titleIds);

        return items.length;
      }),
    importOverrides: (_lease, items) =>
      Effect.sync(() => {
        stored.writes.push(["overrides", items.length]);

        for (const item of items) {
          stored.overrides.set(item.titleId, JSON.stringify(item.overrides));
        }

        return items.length;
      }),
  };

  return backend;
};

const freshStore = (): Stored => ({
  progress: new Map(),
  myList: new Set(),
  collections: new Map(),
  overrides: new Map(),
  libraries: new Map(),
  checkpoint: { phase: "libraries", unit: 0, cursor: 0 },
  imported: NOTHING,
  writes: [],
});

/** The parts of the store a finished import determines. */
const contentsOf = (stored: Stored) => ({
  progress: [...stored.progress.entries()].toSorted(([left], [right]) => left.localeCompare(right)),
  myList: [...stored.myList].toSorted(),
  collections: [...stored.collections.entries()],
  overrides: [...stored.overrides.entries()],
  libraries: [...stored.libraries.entries()],
});

const runWith = (backend: MigrationBackend.Interface) =>
  runMigrationJob(LEASE, () => Effect.void).pipe(
    Effect.provideService(MigrationBackend.Service, backend),
  );

const withFixture = <A, E, R>(use: (url: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(startJellyfinFixture),
    (server) => use(server.url),
    (server) => Effect.promise(server.close),
  );

const environment = Layer.mergeAll(
  testConfigLayer({ MEDIA_SERVICE_API_KEY: SERVICE_KEY, LIBRARY_ROOTS: "/mnt/nas" }),
  FetchHttpClient.layer,
);

layer(environment, { excludeTestServices: true })("runMigrationJob", (it) => {
  it.effect("adds libraries and imports watch state, favorites, collections, and overrides", () =>
    withFixture((url) =>
      Effect.gen(function* () {
        const stored = freshStore();
        const imported = yield* runWith(inMemoryBackend(url, stored));

        assert.deepStrictEqual(imported, {
          librariesAdded: 2,
          watched: 2,
          inProgress: 1,
          // The two played items and the partly watched one carry a last-played date.
          playCounts: 3,
          favorites: 1,
          collections: 1,
          overrides: 1,
          keptLocal: 0,
          unmatched: imported.unmatched,
        });
        assert.deepStrictEqual(stored.checkpoint, { phase: "done", unit: 0, cursor: 0 });

        const progress = [...stored.progress.values()].map((item) => [
          item.profileId,
          item.titleId,
          item.episodeId,
          item.watched,
          item.positionMs,
        ]);

        assert.sameDeepMembers(progress, [
          [ADMIN, "big-buck", null, true, 0],
          [ADMIN, "remux", null, false, 6000],
          [ADMIN, "show", null, false, 0],
          [BOB, "show", "show-1-1", true, 0],
        ]);
        assert.deepStrictEqual([...stored.myList], [`${ADMIN}|show`]);
        assert.deepStrictEqual(
          [...stored.collections.values()],
          [[TitleId.make("big-buck"), TitleId.make("remux")]],
        );
        assert.deepStrictEqual([...stored.overrides.keys()], [TitleId.make("big-buck")]);
      }),
    ),
  );

  it.effect("resumes from its checkpoint after a crash without duplicating anything", () =>
    withFixture((url) =>
      Effect.gen(function* () {
        const uninterrupted = freshStore();
        yield* runWith(inMemoryBackend(url, uninterrupted));

        // Checkpoints: two libraries, scanning, Bob's watch state, then the admin's. The admin's
        // batch is written, but its checkpoint is not.
        const crashed = freshStore();

        const failed = yield* runWith(inMemoryBackend(url, crashed, { failCheckpoint: 5 })).pipe(
          Effect.flip,
        );

        assert.isTrue(Predicate.isTagged(failed, "TransportError"));
        assert.deepStrictEqual(crashed.checkpoint, { phase: "watchState", unit: 0, cursor: 1 });
        assert.deepStrictEqual(crashed.writes, [
          ["watchState", 1],
          ["watchState", 3],
        ]);

        const resumed = yield* runWith(inMemoryBackend(url, crashed));

        assert.deepStrictEqual(contentsOf(crashed), contentsOf(uninterrupted));
        // Only the batch without a checkpoint was written again.
        assert.deepStrictEqual(crashed.writes, [
          ["watchState", 1],
          ["watchState", 3],
          ["watchState", 3],
          ["collections", 1],
          ["overrides", 1],
        ]);
        assert.deepStrictEqual(resumed, uninterrupted.imported);

        // A finished job run again writes nothing.
        const again = yield* runWith(inMemoryBackend(url, crashed));

        assert.deepStrictEqual(again, resumed);
        assert.strictEqual(crashed.writes.length, 5);
      }),
    ),
  );

  it.effect("stops writing once a checkpoint reports the job cancelled", () =>
    withFixture((url) =>
      Effect.gen(function* () {
        const stored = freshStore();
        const cancelled = yield* Deferred.make<void>();
        const backend = inMemoryBackend(url, stored, { cancelAtCheckpoint: 4, cancelled });
        const job = yield* Effect.forkChild(runWith(backend));

        yield* Deferred.await(cancelled);
        yield* Effect.yieldNow;

        // The job waits for the worker to interrupt it and writes nothing more.
        assert.isUndefined(job.pollUnsafe());
        assert.deepStrictEqual(stored.writes, [["watchState", 1]]);
        yield* Fiber.interrupt(job);
      }),
    ),
  );
});
