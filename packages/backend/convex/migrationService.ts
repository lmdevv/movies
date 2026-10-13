/**
 * Functions a migration job calls. Like `mediaService.ts`, every function requires the
 * `media-service` scope; writes also require the job's lease, so a worker that lost it stops.
 *
 * The media service matches source items to [movies] files itself, so imports name [movies] IDs.
 * Every import is idempotent: watched marks stay set, play counts keep the larger value, a
 * position applies only when the source played the item more recently than [movies] did, favorites
 * and collection members are written once, and local metadata overrides win over imported ones.
 */
import type { Infer } from "convex/values";
import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { inSequence, searchTextOf } from "./lib/catalog";
import { fail } from "./lib/errors";
import { enqueueJob, requireLease, requireLeaseOf } from "./lib/jobs";
import {
  catalogFile,
  collectionImport,
  localProgress as localProgressRow,
  migrationCheckpoint,
  migrationImported,
  migrationState,
  migrationTarget,
  overrideImport,
  storedMigrationPlan,
  watchStateImport,
  watchStateImported,
} from "./lib/migrationValidators";
import { findProgress } from "./lib/present";
import { checkRoots } from "./lib/roots";
import { isAdminRole } from "./lib/scopes";
import {
  type externalIds,
  jobProgress,
  leaseArgs,
  libraryKind,
  migrationSource,
  page,
  pageArgs,
  queuedJob,
} from "./lib/validators";
import { authorize } from "./lib/viewer";
import type { ReadCtx } from "./lib/viewer";
import { writeProgress } from "./lib/viewing";

/** Most items one import write may carry; `SCAN_BATCH_LIMIT` in contracts. */
const BATCH_LIMIT = 100;

/** Most members one imported collection keeps. */
const COLLECTION_LIMIT = 1000;

/**
 * Most collections, and members in all, one `importCollections` call may carry, so its deletes
 * and inserts stay inside one mutation's limits; `COLLECTION_BATCH_LIMIT` and
 * `COLLECTION_MEMBER_BATCH_LIMIT` in contracts.
 */
const COLLECTION_BATCH_LIMIT = 10;

const COLLECTION_MEMBER_BATCH_LIMIT = 2000;

const NOTHING_IMPORTED = {
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

const checkBatch = <Item>(items: ReadonlyArray<Item>): ReadonlyArray<Item> =>
  items.length > BATCH_LIMIT
    ? fail("invalid_args", `Send at most ${BATCH_LIMIT} items per call`)
    : items;

const pageSize = (limit: number | undefined): number =>
  Math.min(Math.max(1, Math.floor(limit ?? 100)), 100);

const migrationOf = async (ctx: ReadCtx, jobId: Id<"jobs">): Promise<Doc<"migrations">> =>
  (await ctx.db
    .query("migrations")
    .withIndex("by_job", (q) => q.eq("jobId", jobId))
    .unique()) ?? fail("not_found", "This job has no migration plan");

/** Loads a held migration job's plan. Queries cannot use `requireLease`, so this checks the same. */
const heldMigration = async (
  ctx: ReadCtx,
  jobId: Id<"jobs">,
  workerId: string,
): Promise<Doc<"migrations">> => {
  const job = await ctx.db.get(jobId);

  if (job === null) return fail("not_found", "No such job");

  if (job.status !== "running" || job.leaseOwner !== workerId) {
    return fail("conflict", "This worker no longer holds the job's lease");
  }

  return migrationOf(ctx, jobId);
};

export const targets = query({
  args: {},
  returns: v.array(migrationTarget),
  handler: async (ctx) => {
    await authorize(ctx, "media-service");
    const users = await ctx.db.query("users").collect();

    return Promise.all(
      users
        .filter((user) => user.role !== "service" && user.disabledAt === undefined)
        .map(async (user) => {
          const profiles = await ctx.db
            .query("profiles")
            .withIndex("by_user", (q) => q.eq("userId", user._id))
            .collect();

          return {
            userId: user._id,
            name: user.name ?? user.email ?? "Unnamed",
            email: user.email ?? null,
            profiles: profiles.map((profile) => ({ profileId: profile._id, name: profile.name })),
          };
        }),
    );
  },
});

export const catalog = query({
  args: pageArgs,
  returns: page(catalogFile),
  handler: async (ctx, { cursor, limit }) => {
    await authorize(ctx, "media-service");

    const result = await ctx.db
      .query("mediaFiles")
      .paginate({ numItems: pageSize(limit), cursor: cursor ?? null });

    const titles = new Map<Id<"titles">, Doc<"titles"> | null>();

    const titleOf = async (titleId: Id<"titles">): Promise<Doc<"titles"> | null> => {
      const cached = titles.get(titleId);

      if (cached !== undefined) return cached;
      const title = await ctx.db.get(titleId);
      titles.set(titleId, title);

      return title;
    };

    const items = await inSequence(result.page, async (file) => {
      const title = await titleOf(file.titleId);
      const episode = file.episodeId === null ? null : await ctx.db.get(file.episodeId);

      return title === null
        ? []
        : [
            {
              fileId: file._id,
              libraryId: file.libraryId,
              path: file.path,
              missing: file.missing,
              titleId: title._id,
              kind: title.kind,
              externalIds: title.externalIds,
              episodeId: episode?._id ?? null,
              seasonNumber: episode?.seasonNumber ?? null,
              episodeNumber: episode?.episodeNumber ?? null,
            },
          ];
    });

    return { items: items.flat(), nextCursor: result.isDone ? null : result.continueCursor };
  },
});

export const localProgress = query({
  args: { profileId: v.id("profiles"), ...pageArgs },
  returns: page(localProgressRow),
  handler: async (ctx, { profileId, cursor, limit }) => {
    await authorize(ctx, "media-service");

    const result = await ctx.db
      .query("watchProgress")
      .withIndex("by_profile_played", (q) => q.eq("profileId", profileId))
      .paginate({ numItems: pageSize(limit), cursor: cursor ?? null });

    return {
      items: result.page.map((row) => ({
        titleId: row.titleId,
        episodeId: row.episodeId,
        watched: row.watched,
        positionMs: row.positionMs,
        lastPlayedAt: row.lastPlayedAt,
      })),
      nextCursor: result.isDone ? null : result.continueCursor,
    };
  },
});

/**
 * Queues a migration job with its plan. While a migration of the same source server is queued or
 * running, starting another returns that job, so a double-submitted import runs once.
 */
export const start = mutation({
  args: {
    requestedBy: v.id("users"),
    source: migrationSource,
    serverName: v.string(),
    plan: storedMigrationPlan,
  },
  returns: queuedJob,
  handler: async (ctx, { requestedBy, source, serverName, plan }) => {
    await authorize(ctx, "media-service");
    const requester = await ctx.db.get(requestedBy);

    if (requester === null || requester.disabledAt !== undefined || !isAdminRole(requester.role)) {
      return fail("forbidden", "Only an admin can start a migration");
    }

    const missingProfile = await inSequence(plan.users, async (user) =>
      (await ctx.db.get(user.profileId)) === null ? [user.profileId] : [],
    );

    if (missingProfile.flat().length > 0) {
      return fail("invalid_args", "A mapped profile no longer exists; run the dry run again");
    }

    const sameServer = await ctx.db
      .query("migrations")
      .withIndex("by_server", (q) => q.eq("serverId", plan.serverId))
      .collect();

    const active = await inSequence(sameServer, async (row) => {
      const job = await ctx.db.get(row.jobId);

      return job !== null && (job.status === "pending" || job.status === "running")
        ? [job._id]
        : [];
    });

    const [running] = active.flat();

    if (running !== undefined) return { jobId: running };
    const jobId = await enqueueJob(ctx, { kind: "migration", source, serverName }, requestedBy);

    await ctx.db.insert("migrations", {
      jobId,
      source,
      serverId: plan.serverId,
      serverName,
      plan,
      checkpoint: { phase: "libraries", unit: 0, cursor: 0 },
      imported: NOTHING_IMPORTED,
      libraryIds: [],
    });

    return { jobId };
  },
});

export const state = query({
  args: leaseArgs,
  returns: migrationState,
  handler: async (ctx, { jobId, workerId }) => {
    await authorize(ctx, "media-service");
    const row = await heldMigration(ctx, jobId, workerId);

    return {
      source: row.source,
      serverName: row.serverName,
      plan: row.plan,
      checkpoint: row.checkpoint,
      imported: row.imported,
      libraryIds: row.libraryIds,
    };
  },
});

/** Records where the job resumes. A cancelled job's worker learns it here and stops. */
export const saveCheckpoint = mutation({
  args: {
    ...leaseArgs,
    checkpoint: migrationCheckpoint,
    imported: migrationImported,
    progress: jobProgress,
  },
  returns: v.object({ cancelled: v.boolean() }),
  handler: async (ctx, { jobId, workerId, checkpoint, imported, progress }) => {
    await authorize(ctx, "media-service");
    const doc = await ctx.db.get(jobId);

    if (doc?.status === "cancelled" && doc.leaseOwner === workerId) return { cancelled: true };
    await requireLeaseOf(ctx, jobId, workerId, "migration");
    const row = await migrationOf(ctx, jobId);

    await ctx.db.patch(row._id, { checkpoint, imported });
    await ctx.db.patch(jobId, { progress });

    return { cancelled: false };
  },
});

const isInside = (path: string, root: string): boolean =>
  path === root || path.startsWith(root === "/" ? root : `${root}/`);

/**
 * Finds the libraries covering these folders, or adds one for the folders no library covers yet
 * and queues its scan. Folders inside another library's folder count as covered.
 */
export const ensureLibrary = mutation({
  args: { ...leaseArgs, name: v.string(), kind: libraryKind, roots: v.array(v.string()) },
  returns: v.object({ libraryIds: v.array(v.id("libraries")), created: v.boolean() }),
  handler: async (ctx, { jobId, workerId, name, kind, roots }) => {
    await authorize(ctx, "media-service");
    const doc = await requireLeaseOf(ctx, jobId, workerId, "migration");
    const row = await migrationOf(ctx, jobId);
    const wanted = [...new Set(roots.map((root) => root.trim().replace(/\/+$/u, "") || "/"))];

    const invalid = wanted.find(
      (root) => !root.startsWith("/") || root.split("/").some((part) => part === ".."),
    );

    if (invalid !== undefined) {
      return fail("invalid_args", `Folders must be absolute paths: ${invalid}`);
    }

    const existing = await ctx.db.query("libraries").collect();

    const coveringOf = (root: string) =>
      existing.find((library) => library.roots.some((known) => isInside(root, known)));

    const covering = wanted.flatMap((root) => {
      const library = coveringOf(root);

      return library === undefined ? [] : [library._id];
    });

    const uncovered = wanted.filter((root) => coveringOf(root) === undefined);
    const known = [...new Set(covering)];

    if (uncovered.length === 0) {
      await ctx.db.patch(row._id, { libraryIds: [...new Set([...row.libraryIds, ...known])] });

      return { libraryIds: known, created: false };
    }

    if (doc.requestedBy === null) {
      return fail("invalid_args", "This migration has no requesting admin");
    }

    const added = await checkRoots(ctx, uncovered, null);

    const libraryId = await ctx.db.insert("libraries", {
      name: name.trim() || "Imported library",
      kind,
      roots: added,
      access: "everyone",
      createdBy: doc.requestedBy,
      titleCount: 0,
      lastScanAt: null,
    });

    await enqueueJob(ctx, { kind: "scan", libraryId, mode: "full" }, doc.requestedBy);
    const libraryIds = [...known, libraryId];

    await ctx.db.patch(row._id, {
      libraryIds: [...new Set([...row.libraryIds, ...libraryIds])],
      imported: { ...row.imported, librariesAdded: row.imported.librariesAdded + 1 },
    });

    return { libraryIds, created: true };
  },
});

export const scansPending = query({
  args: { libraryIds: v.array(v.id("libraries")) },
  returns: v.object({ pending: v.number() }),
  handler: async (ctx, { libraryIds }) => {
    await authorize(ctx, "media-service");

    const counts = await inSequence(libraryIds, async (libraryId) => {
      const active = await Promise.all(
        (["pending", "running"] as const).map((status) =>
          ctx.db
            .query("jobs")
            .withIndex("by_library_status", (q) =>
              q.eq("libraryId", libraryId).eq("status", status),
            )
            .first(),
        ),
      );

      return active.some((job) => job !== null) ? 1 : 0;
    });

    return { pending: counts.reduce<number>((total, count) => total + count, 0) };
  },
});

/** What one watch state item changed. */
interface WatchOutcome {
  watched: number;
  inProgress: number;
  playCounts: number;
  favorites: number;
  keptLocal: number;
}

const NO_CHANGE: Readonly<WatchOutcome> = {
  watched: 0,
  inProgress: 0,
  playCounts: 0,
  favorites: 0,
  keptLocal: 0,
};

type WatchItem = (typeof watchStateImport)["type"];

const durationOf = async (
  ctx: MutationCtx,
  fileId: Id<"mediaFiles"> | null,
  existing: Doc<"watchProgress"> | null,
): Promise<number> => {
  const file = fileId === null ? null : await ctx.db.get(fileId);

  return file?.probe.durationMs ?? existing?.durationMs ?? 0;
};

/** Applies one item's progress, watched mark, and play count. */
const importProgress = async (
  ctx: MutationCtx,
  item: WatchItem,
  title: Doc<"titles">,
): Promise<WatchOutcome> => {
  const played = item.watched || item.positionMs > 0 || item.playCount > 0;

  // A show's own row carries favorites only; its progress lives on episodes.
  if (!played || (title.kind === "show" && item.episodeId === null)) return NO_CHANGE;
  const existing = await findProgress(ctx, item.profileId, item.titleId, item.episodeId);

  const sourceNewer =
    existing === null || (item.lastPlayedAt !== null && existing.lastPlayedAt < item.lastPlayedAt);

  const wasWatched = existing?.watched === true;

  const outcome: WatchOutcome = { ...NO_CHANGE };

  if (sourceNewer) {
    await writeProgress(ctx, {
      profileId: item.profileId,
      titleId: item.titleId,
      episodeId: item.episodeId,
      fileId: item.fileId,
      positionMs: item.positionMs,
      durationMs: await durationOf(ctx, item.fileId, existing),
      watched: item.watched,
      playedAt: item.lastPlayedAt ?? existing?.lastPlayedAt ?? 0,
      session: null,
    });

    if (item.positionMs > 0 && existing?.positionMs !== item.positionMs) outcome.inProgress = 1;
  } else {
    if (item.watched && !wasWatched) await ctx.db.patch(existing._id, { watched: true });

    if (existing.positionMs !== item.positionMs || item.watched !== existing.watched) {
      outcome.keptLocal = 1;
    }
  }

  if (item.watched && !wasWatched) outcome.watched = 1;
  const row = await findProgress(ctx, item.profileId, item.titleId, item.episodeId);

  if (row !== null && item.playCount > (row.playCount ?? 0)) {
    await ctx.db.patch(row._id, { playCount: item.playCount });
    outcome.playCounts = 1;
  }

  return outcome;
};

const importFavorite = async (ctx: MutationCtx, item: WatchItem): Promise<number> => {
  if (!item.favorite || item.episodeId !== null) return 0;

  const listed = await ctx.db
    .query("myList")
    .withIndex("by_profile_title", (q) =>
      q.eq("profileId", item.profileId).eq("titleId", item.titleId),
    )
    .unique();

  if (listed !== null) return 0;

  await ctx.db.insert("myList", {
    profileId: item.profileId,
    titleId: item.titleId,
    addedAt: item.lastPlayedAt ?? Date.now(),
  });

  return 1;
};

const importWatchItem = async (ctx: MutationCtx, item: WatchItem): Promise<WatchOutcome> => {
  const profile = await ctx.db.get(item.profileId);
  const title = await ctx.db.get(item.titleId);
  const episode = item.episodeId === null ? null : await ctx.db.get(item.episodeId);

  if (profile === null || title === null) return NO_CHANGE;

  if (item.episodeId !== null && episode?.titleId !== title._id) return NO_CHANGE;
  const progress = await importProgress(ctx, item, title);

  return { ...progress, favorites: await importFavorite(ctx, item) };
};

export const importWatchState = mutation({
  args: { ...leaseArgs, items: v.array(watchStateImport) },
  returns: watchStateImported,
  handler: async (ctx, { jobId, workerId, items }) => {
    await authorize(ctx, "media-service");
    await requireLeaseOf(ctx, jobId, workerId, "migration");
    const outcomes = await inSequence(checkBatch(items), (item) => importWatchItem(ctx, item));

    return outcomes.reduce(
      (total, outcome) => ({
        watched: total.watched + outcome.watched,
        inProgress: total.inProgress + outcome.inProgress,
        playCounts: total.playCounts + outcome.playCounts,
        favorites: total.favorites + outcome.favorites,
        keptLocal: total.keptLocal + outcome.keptLocal,
      }),
      NO_CHANGE,
    );
  },
});

export const importCollections = mutation({
  args: { ...leaseArgs, items: v.array(collectionImport) },
  returns: v.object({ imported: v.number() }),
  handler: async (ctx, { jobId, workerId, items }) => {
    await authorize(ctx, "media-service");
    await requireLease(ctx, jobId, workerId);
    const now = Date.now();
    const memberCount = items.reduce((total, item) => total + item.titleIds.length, 0);

    if (items.length > COLLECTION_BATCH_LIMIT || memberCount > COLLECTION_MEMBER_BATCH_LIMIT) {
      return fail(
        "invalid_args",
        `Send at most ${COLLECTION_BATCH_LIMIT} collections and ${COLLECTION_MEMBER_BATCH_LIMIT} members per call`,
      );
    }

    const imported = await inSequence(items, async (item) => {
      const name = item.name.trim() || "Collection";
      const sortKey = (item.sortName ?? name).trim().toLowerCase();

      const existing = await ctx.db
        .query("collections")
        .withIndex("by_source_key", (q) => q.eq("sourceKey", item.sourceKey))
        .unique();

      const collectionId =
        existing?._id ??
        (await ctx.db.insert("collections", {
          name,
          sortKey,
          sourceKey: item.sourceKey,
          createdAt: now,
          updatedAt: now,
        }));

      if (existing !== null) await ctx.db.patch(existing._id, { name, sortKey, updatedAt: now });

      const members = await ctx.db
        .query("collectionItems")
        .withIndex("by_collection_position", (q) => q.eq("collectionId", collectionId))
        .collect();

      // Members a title's metadata added (a TMDB collection or NFO set) stay; the import's own
      // members are replaced.
      const kept = new Set(
        members.flatMap((member) => (member.source === "metadata" ? [member.titleId] : [])),
      );

      await inSequence(
        members.filter((member) => member.source !== "metadata"),
        (member) => ctx.db.delete(member._id),
      );

      const titleIds = [...new Set(item.titleIds)]
        .filter((titleId) => !kept.has(titleId))
        .slice(0, COLLECTION_LIMIT);

      const present = await inSequence(titleIds, async (titleId) =>
        (await ctx.db.get(titleId)) === null ? [] : [titleId],
      );

      await inSequence(
        present.flat().map((titleId, position) => ({ titleId, position })),
        ({ titleId, position }) =>
          ctx.db.insert("collectionItems", { collectionId, titleId, position }),
      );

      return existing === null ? 1 : 0;
    });

    return { imported: imported.reduce<number>((total, count) => total + count, 0) };
  },
});

/**
 * Fills the provider IDs a title lacks from the source's; IDs [movies] already has are kept. An
 * unmatched title that gains one is queued for a metadata refresh, which looks it up by that ID.
 */
const importExternalIds = async (
  ctx: MutationCtx,
  title: Doc<"titles">,
  ids: Infer<typeof externalIds>,
): Promise<void> => {
  const merged = {
    tmdb: title.externalIds.tmdb ?? ids.tmdb,
    imdb: title.externalIds.imdb ?? ids.imdb,
    tvdb: title.externalIds.tvdb ?? ids.tvdb,
  };

  const gained =
    merged.tmdb !== title.externalIds.tmdb ||
    merged.imdb !== title.externalIds.imdb ||
    merged.tvdb !== title.externalIds.tvdb;

  if (!gained) return;
  await ctx.db.patch(title._id, { externalIds: merged, updatedAt: Date.now() });

  if (title.matchStatus === "unmatched") {
    await enqueueJob(ctx, { kind: "metadata", titleId: title._id, match: null }, null);
  }
};

export const importOverrides = mutation({
  args: { ...leaseArgs, items: v.array(overrideImport) },
  returns: v.object({ imported: v.number() }),
  handler: async (ctx, { jobId, workerId, items }) => {
    await authorize(ctx, "media-service");
    await requireLeaseOf(ctx, jobId, workerId, "migration");

    const imported = await inSequence(checkBatch(items), async (item) => {
      const title = await ctx.db.get(item.titleId);

      if (title === null) return 0;

      if (item.externalIds !== undefined) {
        await importExternalIds(ctx, title, item.externalIds);
      }

      // Overrides an admin made on [movies] win over the source's.
      const overrides = { ...item.overrides, ...title.overrides };
      const before = title.overrides ?? {};

      const changed = Object.keys(overrides).length !== Object.keys(before).length;

      if (!changed) return 0;

      await ctx.db.patch(title._id, {
        overrides,
        searchText: searchTextOf({ ...title, overrides }),
        updatedAt: Date.now(),
      });

      return 1;
    });

    return { imported: imported.reduce<number>((total, count) => total + count, 0) };
  },
});
