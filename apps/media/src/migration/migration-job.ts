/**
 * Runs one claimed migration job. The job is a durable workflow over Convex: its plan and
 * checkpoint live in the job's `migrations` row, every phase writes in batches of at most 100,
 * and a checkpoint follows each batch. A job whose worker died returns to the queue when its
 * lease expires and resumes at its checkpoint; a batch written but not yet checkpointed is
 * written again, which the import mutations make harmless (they are idempotent).
 *
 * The job's counts are what it imported, counted from the plan as the dry run counts them, so a
 * batch written again after a crash counts once and the Done screen matches the Review screen.
 * Only `keptLocal` (items where newer [movies] progress won) comes from Convex.
 *
 * Phases: `libraries` (find or add each library), `scanning` (wait for new libraries' first
 * scans), then `watchState`, `collections`, and `overrides` from a plan computed against the
 * scanned catalog, then `done`. The source is read again on resume; it is only ever read.
 *
 * The job worker (`jobs/job-worker.ts`) claims the job and renews its lease. When an admin
 * cancels, the worker's next renewal interrupts the job where it is; a checkpoint that reports the
 * cancellation first waits for that.
 */
import type { JobProgress } from "@movies/contracts/models/jobs";
import type { MigrationImported, MigrationPhase } from "@movies/contracts/models/migration";
import {
  COLLECTION_BATCH_LIMIT,
  COLLECTION_MEMBER_BATCH_LIMIT,
  type MigrationCheckpoint,
} from "@movies/contracts/models/migration-service";
import type { CallError } from "@movies/sdk/effect";
import { Duration, Effect, Match, Option, Ref } from "effect";
import type { HttpClient } from "effect/http";

import { JobFailed, type JobHandler } from "../jobs/job-worker.ts";
import * as MediaConfig from "../media-config.ts";
import { CredentialsUnreadable, openCredentials } from "./credentials.ts";
import * as MigrationBackend from "./migration-backend.ts";
import type { Lease } from "./migration-backend.ts";
import { computePlan, credentialsBinding } from "./migrations.ts";
import { countImports, type MigrationPlan, type ResolvedUser } from "./planner.ts";
import type { SourceError } from "./source-plugin.ts";
import { openSource } from "./sources.ts";

/** How often the job checks whether new libraries finished their first scan. */
const SCAN_POLL = Duration.seconds(5);

/** How long the job waits for first scans before importing what already matches. */
const SCAN_WAIT = Duration.hours(6);

/** Everything that can end a job early. */
type MigrationJobError = SourceError | CallError | CredentialsUnreadable;

/** Tunables, for tests; production uses the defaults. */
export interface JobOptions {
  readonly scanPoll: Duration.Duration;
  readonly scanWait: Duration.Duration;
}

const defaultOptions: JobOptions = { scanPoll: SCAN_POLL, scanWait: SCAN_WAIT };

const PHASE_MESSAGES: Readonly<Record<MigrationPhase, string>> = {
  libraries: "Adding libraries",
  scanning: "Waiting for new libraries to finish scanning",
  watchState: "Importing watch history and favorites",
  collections: "Importing collections",
  overrides: "Importing metadata overrides",
  done: "Imported",
};

/** A batch of items and the index of its first item. */
interface Batch<Item> {
  readonly start: number;
  readonly items: ReadonlyArray<Item>;
}

/**
 * Consecutive batches of `items` from index `from`, each with at most `size` items and, when
 * `weight` is given, a total weight of at most `maxWeight`. An item heavier than `maxWeight` goes
 * alone.
 */
export const batchesOf = <Item>(
  items: ReadonlyArray<Item>,
  from: number,
  size: number,
  limit?: { readonly maxWeight: number; readonly weight: (item: Item) => number },
): ReadonlyArray<Batch<Item>> => {
  const result: Array<Batch<Item>> = [];
  let start = from;

  while (start < items.length) {
    let end = start;
    let weight = 0;

    for (const item of items.slice(start, start + size)) {
      const next = limit === undefined ? 0 : limit.weight(item);

      if (end > start && limit !== undefined && weight + next > limit.maxWeight) break;
      weight += next;
      end += 1;
    }

    result.push({ start, items: items.slice(start, end) });
    start = end;
  }

  return result;
};

const isBefore = (phase: MigrationPhase, other: MigrationPhase): boolean => {
  const order: ReadonlyArray<MigrationPhase> = [
    "libraries",
    "scanning",
    "watchState",
    "collections",
    "overrides",
    "done",
  ];

  return order.indexOf(phase) < order.indexOf(other);
};

/** One line of what was imported, for the job's final message. */
const doneMessage = (imported: MigrationImported): string =>
  [
    `${String(imported.watched)} watched`,
    `${String(imported.inProgress)} in progress`,
    `${String(imported.favorites)} favorites`,
    `${String(imported.collections)} collections`,
    `${String(imported.overrides)} overrides`,
    `${String(imported.keptLocal)} kept newer [movies] progress`,
    `${String(imported.unmatched)} unmatched`,
  ].join(", ");

/**
 * Runs the held job `lease` from its checkpoint to its end and returns what it imported.
 * `reportProgress` receives the progress of each checkpoint, for the worker's lease renewals.
 */
export const runMigrationJob = Effect.fn("MigrationJob.run")(function* (
  lease: Lease,
  reportProgress: (progress: JobProgress) => Effect.Effect<void>,
  options: JobOptions = defaultOptions,
) {
  const backend = yield* MigrationBackend.Service;
  const config = yield* MediaConfig.Service;

  const state = yield* backend.state(lease);

  if (Option.isNone(config.mediaServiceApiKey)) return yield* new CredentialsUnreadable();

  const credentials = yield* openCredentials(
    config.mediaServiceApiKey.value,
    state.plan.credentials,
    credentialsBinding(state.plan.serverId, state.plan.sourceUrl),
  );

  const session = yield* openSource(state.source, {
    url: state.plan.sourceUrl,
    credentials,
  });

  const checkpoint = yield* Ref.make<MigrationCheckpoint>(state.checkpoint);
  const imported = yield* Ref.make<MigrationImported>(state.imported);

  /** Records a step; stops when the job was cancelled. */
  const save = Effect.fnUntraced(function* (
    next: MigrationCheckpoint,
    done: number,
    total: number | null,
  ) {
    const current: JobProgress = { done, total, message: PHASE_MESSAGES[next.phase] };

    yield* Ref.set(checkpoint, next);
    yield* reportProgress(current);

    const cancelled = yield* backend.saveCheckpoint(lease, next, yield* Ref.get(imported), current);

    // Cancelled: the worker's next lease renewal sees it too and interrupts the job.
    yield* cancelled ? Effect.never : Effect.void;
  });

  const add = (counts: Partial<MigrationImported>) =>
    Ref.update(imported, (current) => ({
      librariesAdded: current.librariesAdded + (counts.librariesAdded ?? 0),
      watched: current.watched + (counts.watched ?? 0),
      inProgress: current.inProgress + (counts.inProgress ?? 0),
      playCounts: current.playCounts + (counts.playCounts ?? 0),
      favorites: current.favorites + (counts.favorites ?? 0),
      collections: current.collections + (counts.collections ?? 0),
      overrides: current.overrides + (counts.overrides ?? 0),
      keptLocal: current.keptLocal + (counts.keptLocal ?? 0),
      unmatched: counts.unmatched ?? current.unmatched,
    }));

  // Libraries: one unit per planned library.
  const libraryIds = new Set(state.libraryIds);
  const libraries = state.plan.libraries;

  if (state.checkpoint.phase === "libraries") {
    for (let unit = state.checkpoint.unit; unit < libraries.length; unit += 1) {
      const library = libraries[unit];

      if (library === undefined) continue;
      const ensured = yield* backend.ensureLibrary(lease, library);

      for (const libraryId of ensured.libraryIds) libraryIds.add(libraryId);

      // `ensureLibrary` counts added libraries on the migration row itself.
      if (ensured.created) yield* add({ librariesAdded: 1 });
      yield* save({ phase: "libraries", unit: unit + 1, cursor: 0 }, unit + 1, libraries.length);
    }

    yield* save({ phase: "scanning", unit: 0, cursor: 0 }, 0, null);
  }

  // Scanning: wait for the libraries' scans so new files match by path.
  if (isBefore((yield* Ref.get(checkpoint)).phase, "watchState")) {
    yield* Effect.gen(function* () {
      while ((yield* backend.scansPending([...libraryIds])) > 0) {
        yield* Effect.sleep(options.scanPoll);
      }
    }).pipe(Effect.timeoutOption(options.scanWait));
  }

  const users: ReadonlyArray<ResolvedUser> = state.plan.users.map((user) => ({
    sourceUserId: user.sourceUserId,
    name: user.sourceUserId,
    profileId: user.profileId,
    action: "import",
    history: user.history,
  }));

  const plan: MigrationPlan = yield* computePlan(
    session,
    state.source,
    users,
    state.plan.pathMappings,
    config.libraryRoots,
    false,
  ).pipe(Effect.provideService(MigrationBackend.Service, backend));

  yield* add({ unmatched: plan.summary.itemsUnmatched + plan.summary.itemsAwaitingScan });

  const watchTotal = plan.watchState.reduce((total, user) => total + user.items.length, 0);

  const total = watchTotal + plan.collections.length + plan.overrides.length;

  // Watch state: one unit per mapped user, in source user order.
  if (isBefore((yield* Ref.get(checkpoint)).phase, "collections")) {
    const start = yield* Ref.get(checkpoint);

    const resume =
      start.phase === "watchState" ? start : { phase: "watchState" as const, unit: 0, cursor: 0 };

    let done = plan.watchState
      .slice(0, resume.unit)
      .reduce((sum, user) => sum + user.items.length, resume.cursor);

    for (let unit = resume.unit; unit < plan.watchState.length; unit += 1) {
      const user = plan.watchState[unit];

      if (user === undefined) continue;
      const from = unit === resume.unit ? resume.cursor : 0;

      for (const batch of batchesOf(user.items, from, MigrationBackend.BATCH_SIZE)) {
        const { keptLocal } = yield* backend.importWatchState(lease, batch.items);

        yield* add({ ...countImports(batch.items), keptLocal });
        done += batch.items.length;
        yield* save(
          { phase: "watchState", unit, cursor: batch.start + batch.items.length },
          done,
          total,
        );
      }
    }

    yield* save({ phase: "collections", unit: 0, cursor: 0 }, watchTotal, total);
  }

  if (isBefore((yield* Ref.get(checkpoint)).phase, "overrides")) {
    const from = (yield* Ref.get(checkpoint)).cursor;

    for (const batch of batchesOf(plan.collections, from, COLLECTION_BATCH_LIMIT, {
      maxWeight: COLLECTION_MEMBER_BATCH_LIMIT,
      weight: (collection) => collection.titleIds.length,
    })) {
      yield* backend.importCollections(lease, batch.items);
      yield* add({ collections: batch.items.length });
      const cursor = batch.start + batch.items.length;
      yield* save({ phase: "collections", unit: 0, cursor }, watchTotal + cursor, total);
    }

    yield* save(
      { phase: "overrides", unit: 0, cursor: 0 },
      watchTotal + plan.collections.length,
      total,
    );
  }

  if (isBefore((yield* Ref.get(checkpoint)).phase, "done")) {
    const from = (yield* Ref.get(checkpoint)).cursor;

    for (const batch of batchesOf(plan.overrides, from, MigrationBackend.BATCH_SIZE)) {
      yield* backend.importOverrides(lease, batch.items);
      yield* add({ overrides: batch.items.length });
      const cursor = batch.start + batch.items.length;

      yield* save(
        { phase: "overrides", unit: 0, cursor },
        watchTotal + plan.collections.length + cursor,
        total,
      );
    }

    yield* save({ phase: "done", unit: 0, cursor: 0 }, total, total);
  }

  return yield* Ref.get(imported);
});

/** Whether a failure may pass if the job runs again later. */
const isTransient: (error: MigrationJobError) => boolean = Match.type<MigrationJobError>().pipe(
  Match.tags({
    SourceUnreachable: () => true,
    TransportError: () => true,
    Internal: () => true,
    RateLimited: () => true,
    // The lease moved to another worker or expired; whoever holds it carries on.
    Conflict: () => true,
  }),
  Match.orElse(() => false),
);

/** The migration job handler. */
export const handler: Effect.Effect<
  JobHandler,
  never,
  MigrationBackend.Service | MediaConfig.Service | HttpClient.HttpClient
> = Effect.gen(function* () {
  const context = yield* Effect.context<
    MigrationBackend.Service | MediaConfig.Service | HttpClient.HttpClient
  >();

  return {
    kind: "migration",
    run: (claim, workerId, reportProgress) =>
      runMigrationJob({ jobId: claim.job.id, workerId }, reportProgress).pipe(
        Effect.map(doneMessage),
        Effect.mapError(
          (error) => new JobFailed({ message: error.message, retry: isTransient(error) }),
        ),
        Effect.provideContext(context),
      ),
  };
});
