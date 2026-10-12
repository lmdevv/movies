/**
 * Functions for the media service, which signs in with `MEDIA_SERVICE_API_KEY` through the
 * `apikey` provider. Every function here requires the `media-service` scope, which only that key's
 * session holds; user sessions are refused, and the service session is refused everywhere else.
 */
import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import {
  inSequence,
  markFileMissing,
  searchTextOf,
  titleMetadata,
  upsertEpisode,
  upsertScannedItem,
} from "./lib/catalog";
import { fail } from "./lib/errors";
import { MAX_JOB_ATTEMPTS, requireLease, requireLeaseOf } from "./lib/jobs";
import { presentJob } from "./lib/present";
import {
  backupArchive,
  claimedJob,
  endedSession,
  indexedFile,
  job,
  jobProgress,
  leaseArgs,
  mediaLibrary,
  metadataTarget as metadataTargetResult,
  ok,
  page,
  pageArgs,
  playbackMode,
  resolvedFile,
  scannedEpisode,
  scannedItem,
  scannedTitle,
  sessionStatus as sessionStatusResult,
  upsertedFile,
} from "./lib/validators";
import { authorize } from "./lib/viewer";

/** Most items one scan or import write may carry; `SCAN_BATCH_LIMIT` in contracts. */
const BATCH_LIMIT = 100;

/** Most archives one backup sync may carry; `BACKUP_SYNC_LIMIT` in contracts. */
const BACKUP_SYNC_LIMIT = 1000;

const MIN_LEASE_MS = 5_000;

const MAX_LEASE_MS = 600_000;

const checkBatch = <Item>(items: ReadonlyArray<Item>): ReadonlyArray<Item> =>
  items.length > BATCH_LIMIT
    ? fail("invalid_args", `Send at most ${BATCH_LIMIT} items per call`)
    : items;

const checkLease = (leaseMs: number): number =>
  Number.isInteger(leaseMs) && leaseMs >= MIN_LEASE_MS && leaseMs <= MAX_LEASE_MS
    ? leaseMs
    : fail("invalid_args", "Leases last from 5 seconds to 10 minutes");

const presentMediaLibrary = (doc: Doc<"libraries">) => ({
  id: doc._id,
  name: doc.name,
  kind: doc.kind,
  roots: doc.roots,
});

const requireLibrary = async (
  ctx: MutationCtx,
  libraryId: Id<"libraries">,
): Promise<Doc<"libraries">> =>
  (await ctx.db.get(libraryId)) ?? fail("not_found", "No such library");

/** Jobs waiting for a worker, oldest first. Expired leases return here through a cron. */
export const pendingJobs = query({
  args: {},
  returns: v.array(job),
  handler: async (ctx) => {
    await authorize(ctx, "media-service");

    const pending = await ctx.db
      .query("jobs")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .take(50);

    return pending.map(presentJob);
  },
});

export const claimJob = mutation({
  args: { ...leaseArgs, leaseMs: v.number() },
  returns: v.union(v.null(), claimedJob),
  handler: async (ctx, { jobId, workerId, leaseMs }) => {
    await authorize(ctx, "media-service");
    const doc = await ctx.db.get(jobId);
    const now = Date.now();

    const claimable =
      doc !== null &&
      (doc.status === "pending" || (doc.status === "running" && (doc.leaseExpiresAt ?? 0) <= now));

    if (!claimable) return null;
    const leaseExpiresAt = now + checkLease(leaseMs);

    await ctx.db.patch(jobId, {
      status: "running",
      leaseOwner: workerId,
      leaseExpiresAt,
      attempts: doc.attempts + 1,
      startedAt: doc.startedAt ?? now,
    });

    const claimed = await ctx.db.get(jobId);

    if (claimed === null) return null;
    const library = doc.payload.kind === "scan" ? await ctx.db.get(doc.payload.libraryId) : null;

    return {
      job: presentJob(claimed),
      library: library === null ? null : presentMediaLibrary(library),
      leaseExpiresAt,
    };
  },
});

export const renewLease = mutation({
  args: { ...leaseArgs, leaseMs: v.number(), progress: v.optional(jobProgress) },
  returns: v.object({ leaseExpiresAt: v.number(), cancelled: v.boolean() }),
  handler: async (ctx, { jobId, workerId, leaseMs, progress }) => {
    await authorize(ctx, "media-service");
    const doc = await ctx.db.get(jobId);

    if (doc?.status === "cancelled" && doc.leaseOwner === workerId) {
      return { leaseExpiresAt: doc.leaseExpiresAt ?? 0, cancelled: true };
    }

    await requireLease(ctx, jobId, workerId);
    const leaseExpiresAt = Date.now() + checkLease(leaseMs);

    await ctx.db.patch(
      jobId,
      progress === undefined ? { leaseExpiresAt } : { leaseExpiresAt, progress },
    );

    return { leaseExpiresAt, cancelled: false };
  },
});

export const completeJob = mutation({
  args: { ...leaseArgs, message: v.optional(v.string()) },
  returns: ok,
  handler: async (ctx, { jobId, workerId, message }) => {
    await authorize(ctx, "media-service");
    const doc = await requireLease(ctx, jobId, workerId);
    const now = Date.now();

    await ctx.db.patch(jobId, {
      status: "succeeded",
      finishedAt: now,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      progress: { ...doc.progress, message: message ?? doc.progress.message },
    });

    if (doc.payload.kind === "scan" && (await ctx.db.get(doc.payload.libraryId)) !== null) {
      await ctx.db.patch(doc.payload.libraryId, { lastScanAt: now });
    }

    return { ok: true as const };
  },
});

export const failJob = mutation({
  args: { ...leaseArgs, error: v.string(), retry: v.boolean() },
  returns: ok,
  handler: async (ctx, { jobId, workerId, error, retry }) => {
    await authorize(ctx, "media-service");
    const doc = await requireLease(ctx, jobId, workerId);
    const again = retry && doc.attempts < MAX_JOB_ATTEMPTS;

    await ctx.db.patch(jobId, {
      status: again ? "pending" : "failed",
      error,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      finishedAt: again ? null : Date.now(),
    });

    return { ok: true as const };
  },
});

export const libraries = query({
  args: {},
  returns: v.array(mediaLibrary),
  handler: async (ctx) => {
    await authorize(ctx, "media-service");
    const docs = await ctx.db.query("libraries").collect();

    return docs.map(presentMediaLibrary);
  },
});

export const fileIndex = query({
  args: { libraryId: v.id("libraries"), ...pageArgs },
  returns: page(indexedFile),
  handler: async (ctx, { libraryId, cursor, limit }) => {
    await authorize(ctx, "media-service");

    const result = await ctx.db
      .query("mediaFiles")
      .withIndex("by_library_path", (q) => q.eq("libraryId", libraryId))
      .paginate({
        numItems: Math.min(Math.max(1, Math.floor(limit ?? 100)), 100),
        cursor: cursor ?? null,
      });

    return {
      items: result.page.map((file) => ({
        path: file.path,
        sizeBytes: file.sizeBytes,
        mtimeMs: file.mtimeMs,
        missing: file.missing,
      })),
      nextCursor: result.isDone ? null : result.continueCursor,
    };
  },
});

export const upsertScanned = mutation({
  args: { libraryId: v.id("libraries"), items: v.array(scannedItem) },
  returns: v.array(upsertedFile),
  handler: async (ctx, { libraryId, items }) => {
    await authorize(ctx, "media-service");
    const library = await requireLibrary(ctx, libraryId);

    const inside = (path: string) =>
      !path.split("/").some((segment) => segment === ".." || segment === ".") &&
      library.roots.some(
        (root) => path === root || path.startsWith(root === "/" ? root : `${root}/`),
      );

    const outside = checkBatch(items).find((item) => !inside(item.file.path));

    if (outside !== undefined) {
      return fail("invalid_args", `${outside.file.path} is outside the library's folders`);
    }

    return inSequence(items, (item) => upsertScannedItem(ctx, libraryId, item));
  },
});

export const markMissing = mutation({
  args: { libraryId: v.id("libraries"), paths: v.array(v.string()) },
  returns: v.object({ marked: v.number() }),
  handler: async (ctx, { libraryId, paths }) => {
    await authorize(ctx, "media-service");
    await requireLibrary(ctx, libraryId);

    const marked = await inSequence(checkBatch(paths), (path) =>
      markFileMissing(ctx, libraryId, path),
    );

    return { marked: marked.filter(Boolean).length };
  },
});

export const resolveFile = query({
  args: { fileId: v.id("mediaFiles") },
  returns: resolvedFile,
  handler: async (ctx, { fileId }) => {
    await authorize(ctx, "media-service");
    const file = await ctx.db.get(fileId);

    if (file === null) return fail("not_found", "No such file");
    const library = await ctx.db.get(file.libraryId);

    if (library === null) return fail("not_found", "This file's library was removed");

    return {
      fileId,
      libraryId: library._id,
      path: file.path,
      roots: library.roots,
      probe: file.probe,
      externalSubtitles: file.externalSubtitles,
      missing: file.missing,
    };
  },
});

export const sessionStatus = query({
  args: { sessionId: v.id("playbackSessions") },
  returns: sessionStatusResult,
  handler: async (ctx, { sessionId }) => {
    await authorize(ctx, "media-service");
    const session = await ctx.db.get(sessionId);

    if (session === null) return fail("not_found", "No such playback session");

    return { sessionId, status: session.status, fileId: session.fileId, endedAt: session.endedAt };
  },
});

/**
 * Sessions that ended after `after`, oldest first; the media service stops their streams and asks
 * again after the latest `endedAt` it saw. A page never splits one `endedAt`: a sign-out or a
 * restore ends many sessions in the same millisecond, and the ones past the limit would otherwise
 * be skipped by the next page.
 */
export const endedSessions = query({
  args: { after: v.number(), limit: v.optional(v.number()) },
  returns: v.array(endedSession),
  handler: async (ctx, { after, limit }) => {
    await authorize(ctx, "media-service");
    const wanted = Math.min(Math.max(1, Math.floor(limit ?? 100)), 200);

    const ended = await ctx.db
      .query("playbackSessions")
      .withIndex("by_status_ended", (q) => q.eq("status", "ended").gt("endedAt", after))
      .take(wanted);

    const last = ended.at(-1)?.endedAt ?? null;

    const ties =
      ended.length < wanted || last === null
        ? []
        : await ctx.db
            .query("playbackSessions")
            .withIndex("by_status_ended", (q) => q.eq("status", "ended").eq("endedAt", last))
            .collect();

    const unique = new Map([...ended, ...ties].map((session) => [session._id, session]));

    return [...unique.values()].flatMap((session) =>
      session.endedAt === null ? [] : [{ sessionId: session._id, endedAt: session.endedAt }],
    );
  },
});

export const recordPlaybackMode = mutation({
  args: { sessionId: v.id("playbackSessions"), mode: playbackMode },
  returns: ok,
  handler: async (ctx, { sessionId, mode }) => {
    await authorize(ctx, "media-service");

    if ((await ctx.db.get(sessionId)) === null)
      return fail("not_found", "No such playback session");
    await ctx.db.patch(sessionId, { mode });

    return { ok: true as const };
  },
});

export const metadataTarget = query({
  args: { titleId: v.id("titles") },
  returns: metadataTargetResult,
  handler: async (ctx, { titleId }) => {
    await authorize(ctx, "media-service");
    const title = await ctx.db.get(titleId);

    if (title === null) return fail("not_found", "No such title");

    const episodes = await ctx.db
      .query("episodes")
      .withIndex("by_title_order", (q) => q.eq("titleId", titleId))
      .collect();

    return {
      titleId,
      libraryId: title.libraryId,
      kind: title.kind,
      name: title.overrides?.name ?? title.name,
      year: title.overrides?.year ?? title.year,
      externalIds: title.externalIds,
      artwork: title.artwork,
      episodes: episodes.map((episode) => ({
        seasonNumber: episode.seasonNumber,
        episodeNumber: episode.episodeNumber,
      })),
    };
  },
});

/**
 * Writes fetched metadata during a metadata job. A job carrying a manual match marks the title
 * manual, so later scans keep its files and metadata.
 */
export const applyMetadata = mutation({
  args: {
    ...leaseArgs,
    titleId: v.id("titles"),
    title: scannedTitle,
    episodes: v.array(scannedEpisode),
  },
  returns: ok,
  handler: async (ctx, { jobId, workerId, titleId, title, episodes }) => {
    await authorize(ctx, "media-service");
    const doc = await requireLeaseOf(ctx, jobId, workerId, "metadata");

    if (doc.payload.titleId !== titleId)
      return fail("invalid_args", "This job is for another title");
    const current = await ctx.db.get(titleId);

    if (current === null) return fail("not_found", "No such title");
    const metadata = { ...titleMetadata(title), kind: current.kind };

    await ctx.db.patch(titleId, {
      ...metadata,
      matchStatus: doc.payload.match === null ? title.matchStatus : "manual",
      updatedAt: Date.now(),
      searchText: searchTextOf({ ...metadata, overrides: current.overrides }),
    });

    if (current.kind === "show") {
      await inSequence(checkBatch(episodes), (episode) => upsertEpisode(ctx, titleId, episode));
    }

    return { ok: true as const };
  },
});

export const recordBackup = mutation({
  args: { ...leaseArgs, fileName: v.string(), sizeBytes: v.number() },
  returns: v.object({ backupId: v.id("backups") }),
  handler: async (ctx, { jobId, workerId, fileName, sizeBytes }) => {
    await authorize(ctx, "media-service");
    const doc = await requireLeaseOf(ctx, jobId, workerId, "backup");

    const backupId = await ctx.db.insert("backups", {
      fileName,
      sizeBytes,
      trigger: doc.payload.trigger,
      jobId,
    });

    return { backupId };
  },
});

/** The archive file of a backup, for a restore. */
export const backupFile = query({
  args: { backupId: v.id("backups") },
  returns: v.object({ fileName: v.string() }),
  handler: async (ctx, { backupId }) => {
    await authorize(ctx, "media-service");
    const doc = (await ctx.db.get(backupId)) ?? fail("not_found", "No such backup");

    return { fileName: doc.fileName };
  },
});

/**
 * Makes the backups table list exactly the archives in the media service's backup folder: rows
 * without a file go (retention pruned it), and files without a row are added (a restore replaced
 * the table with an older one, or an admin copied an archive in). Safe to repeat.
 */
export const syncBackups = mutation({
  args: { archives: v.array(backupArchive) },
  returns: v.object({ added: v.number(), removed: v.number() }),
  handler: async (ctx, { archives }) => {
    await authorize(ctx, "media-service");

    if (archives.length > BACKUP_SYNC_LIMIT) {
      return fail("invalid_args", `Send at most ${BACKUP_SYNC_LIMIT} archives`);
    }

    const rows = await ctx.db.query("backups").collect();
    const onDisk = new Set(archives.map((archive) => archive.fileName));
    const recorded = new Set(rows.map((row) => row.fileName));
    const stale = rows.filter((row) => !onDisk.has(row.fileName));
    const missing = archives.filter((archive) => !recorded.has(archive.fileName));

    await Promise.all(stale.map((row) => ctx.db.delete(row._id)));
    await Promise.all(missing.map((archive) => ctx.db.insert("backups", archive)));

    return { added: missing.length, removed: stale.length };
  },
});
