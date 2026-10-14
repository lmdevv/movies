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
import {
  checkBatch,
  checkOverrides,
  COLLECTION_BATCH_LIMIT,
  COLLECTION_MEMBER_BATCH_LIMIT,
  resultLimit,
} from "./lib/bounds";
import { inSequence, writeOverrides } from "./lib/catalog";
import { fail } from "./lib/errors";
import { enqueueJob, isLibraryScanning, requireLease, requireLeaseOf } from "./lib/jobs";
import {
  catalogFile,
  collectionImport,
  localProgress as localProgressRow,
  migrationCheckpoint,
  migrationImported,
  migrationState,
  migrationTarget,
  NOTHING_IMPORTED,
  overrideImport,
  storedMigrationPlan,
  watchStateImport,
  watchStateImported,
} from "./lib/migrationValidators";
import { findProgress } from "./lib/present";
import {
  checkAbsolute,
  checkRoots,
  librariesOverlapping,
  normalizeRoot,
  outermostRoots,
} from "./lib/roots";
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

/** Most members one imported collection keeps. */
const COLLECTION_LIMIT = 1000;

const pageSize = (limit: number | undefined): number => resultLimit(limit, 100, 100);

const migrationOf = async (ctx: ReadCtx, jobId: Id<"jobs">): Promise<Doc<"migrations">> =>
  (await ctx.db
    .query("migrations")
    .withIndex("by_job", (q) => q.eq("jobId", jobId))
    .unique()) ?? fail("not_found", "This job has no migration plan");

/** Loads a held migration job's plan. */
const heldMigration = async (
  ctx: ReadCtx,
  jobId: Id<"jobs">,
  workerId: string,
): Promise<Doc<"migrations">> => {
  await requireLease(ctx, jobId, workerId);

  return migrationOf(ctx, jobId);
};

/**
 * Every enabled account other than the service account, with its profiles, for mapping source users
 * onto [movies] profiles.
 */
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

/**
 * Every file in [movies] with its title, episode numbers, and provider IDs, for matching source
 * items to [movies] files. Files whose title is gone are left out, so a page can come back short.
 */
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

/** A profile's progress rows, for a dry run to compare with the source's watch state. */
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

/**
 * A held migration job's plan, checkpoint, import counts, and libraries, so a worker resumes where
 * the last one stopped. Fails with `conflict` when the worker lost the lease.
 */
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

/** A set of folders as one comparable string, whatever their order and spelling. */
const folderSetKey = (folders: ReadonlyArray<string>): string =>
  JSON.stringify([...new Set(folders.map(normalizeRoot))].toSorted());

/**
 * Who sees a library added for these folders, from the stored plan the admin reviewed: the
 * planned library with the same folders. A call naming folders the plan does not list gets none,
 * so the library is admins-only.
 */
const plannedAccessOf = (plan: Doc<"migrations">["plan"], roots: ReadonlyArray<string>) =>
  plan.libraries.find((library) => folderSetKey(library.roots) === folderSetKey(roots))?.access;

/**
 * The accounts an added library is granted to: those whose profiles receive the history of the
 * listed source users. Source users the plan does not import get nothing.
 */
const grantedAccounts = async (
  ctx: ReadCtx,
  plan: Doc<"migrations">["plan"],
  sourceUserIds: ReadonlyArray<string>,
): Promise<Array<Id<"users">>> => {
  const listed = new Set(sourceUserIds);

  const accounts = await inSequence(
    plan.users.filter((user) => listed.has(user.sourceUserId)),
    async (user) => (await ctx.db.get(user.profileId))?.userId ?? null,
  );

  return [...new Set(accounts.flatMap((userId) => (userId === null ? [] : [userId])))];
};

/**
 * Finds the libraries covering these folders, or adds one for the folders no library covers yet
 * and queues its scan. A folder inside, or holding, another library's folder counts as covered by
 * that library, since libraries never nest; files outside it stay unmatched. An added library
 * is open to everyone only when the source showed it to every user; otherwise it is restricted,
 * granted to the accounts of the imported users who could see it (none when the source did not
 * say, or for plans stored before access was recorded). Access comes from the stored plan, never
 * from the caller. Libraries already here keep their access.
 */
export const ensureLibrary = mutation({
  args: {
    ...leaseArgs,
    name: v.string(),
    kind: libraryKind,
    roots: v.array(v.string()),
  },
  returns: v.object({ libraryIds: v.array(v.id("libraries")), created: v.boolean() }),
  handler: async (ctx, { jobId, workerId, name, kind, roots }) => {
    await authorize(ctx, "media-service");
    const doc = await requireLeaseOf(ctx, jobId, workerId, "migration");
    const row = await migrationOf(ctx, jobId);
    // Folders inside another of these folders are covered by it: one library never nests.
    const wanted = outermostRoots([...new Set(roots.map(normalizeRoot))]);

    checkAbsolute(wanted);
    const existing = await ctx.db.query("libraries").collect();
    // A library whose folder holds this one, or lies inside it: adding another would nest them.
    const coveringOf = (root: string) => librariesOverlapping(root, existing);

    const covering = wanted.flatMap((root) => coveringOf(root).map((library) => library._id));
    const uncovered = wanted.filter((root) => coveringOf(root).length === 0);
    const known = [...new Set(covering)];

    if (uncovered.length === 0) {
      await ctx.db.patch(row._id, { libraryIds: [...new Set([...row.libraryIds, ...known])] });

      return { libraryIds: known, created: false };
    }

    if (doc.requestedBy === null) {
      return fail("invalid_args", "This migration has no requesting admin");
    }

    const added = await checkRoots(ctx, uncovered, null);
    const access = plannedAccessOf(row.plan, roots);

    const libraryId = await ctx.db.insert("libraries", {
      name: name.trim() || "Imported library",
      kind,
      roots: added,
      access: access?.kind === "everyone" ? "everyone" : "restricted",
      createdBy: doc.requestedBy,
      titleCount: 0,
      lastScanAt: null,
    });

    const granted =
      access?.kind === "users" ? await grantedAccounts(ctx, row.plan, access.sourceUserIds) : [];

    await inSequence(granted, (userId) => ctx.db.insert("libraryGrants", { userId, libraryId }));

    await enqueueJob(ctx, { kind: "scan", libraryId, mode: "full" }, doc.requestedBy);
    const libraryIds = [...known, libraryId];

    await ctx.db.patch(row._id, {
      libraryIds: [...new Set([...row.libraryIds, ...libraryIds])],
      imported: { ...row.imported, librariesAdded: row.imported.librariesAdded + 1 },
    });

    return { libraryIds, created: true };
  },
});

/**
 * How many of the given libraries still have a scan queued or running, so a migration waits for its
 * new libraries before matching files.
 */
export const scansPending = query({
  args: { libraryIds: v.array(v.id("libraries")) },
  returns: v.object({ pending: v.number() }),
  handler: async (ctx, { libraryIds }) => {
    await authorize(ctx, "media-service");

    const counts = await inSequence(libraryIds, async (libraryId) =>
      (await isLibraryScanning(ctx, libraryId)) ? 1 : 0,
    );

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

/**
 * Imports up to 100 watch state items for mapped profiles and returns what changed. Safe to repeat:
 * watched marks only get set, play counts keep the larger value, a position applies only when the
 * source played the item more recently, and a favorite adds the title to My List once. Items whose
 * profile, title, or episode is gone are skipped.
 */
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

/**
 * Imports up to 10 collections and 2000 members per call, matched to earlier imports by source key.
 * Each collection's imported members are replaced while members its titles' metadata added stay.
 * Returns how many collections were new.
 */
export const importCollections = mutation({
  args: { ...leaseArgs, items: v.array(collectionImport) },
  returns: v.object({ imported: v.number() }),
  handler: async (ctx, { jobId, workerId, items }) => {
    await authorize(ctx, "media-service");
    await requireLeaseOf(ctx, jobId, workerId, "migration");
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

/**
 * Imports up to 100 titles' metadata overrides and provider IDs. Overrides and IDs already on
 * [movies] win; an unmatched title that gains a provider ID gets a metadata job. Returns how many
 * titles' overrides changed.
 */
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
      const overrides = { ...checkOverrides(item.overrides), ...title.overrides };
      const before = title.overrides ?? {};

      const changed = Object.keys(overrides).length !== Object.keys(before).length;

      if (!changed) return 0;

      await writeOverrides(ctx, title, overrides);

      return 1;
    });

    return { imported: imported.reduce<number>((total, count) => total + count, 0) };
  },
});
