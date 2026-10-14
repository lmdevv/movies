import { v } from "convex/values";

import type { Infer } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import type { QueryCtx } from "./_generated/server";
import { internalMutation, mutation, query } from "./_generated/server";
import { visibleLibraryIds } from "./lib/access";
import { inSequence } from "./lib/catalog";
import { fail } from "./lib/errors";
import { checkDisplayName, resultLimit } from "./lib/bounds";
import { enqueueJob, isLibraryScanning } from "./lib/jobs";
import { checkRoots } from "./lib/roots";
import { forgetTrickplay, queueTrickplay } from "./lib/trickplay";
import { presentLibrary, presentLibraryDetail } from "./lib/present";
import {
  library,
  libraryAccess,
  libraryDetail,
  libraryFile,
  libraryFileFilter,
  libraryFileSummary,
  libraryKind,
  ok,
  page,
  pageArgs,
  queuedJob,
  scanMode,
} from "./lib/validators";
import { authorize } from "./lib/viewer";

const grantedUsers = async (ctx: QueryCtx, libraryId: Id<"libraries">) => {
  const grants = await ctx.db
    .query("libraryGrants")
    .withIndex("by_library", (q) => q.eq("libraryId", libraryId))
    .collect();

  return grants.map((grant) => grant.userId);
};

const detail = async (ctx: QueryCtx, doc: Doc<"libraries">) =>
  presentLibraryDetail(
    doc,
    await isLibraryScanning(ctx, doc._id),
    await grantedUsers(ctx, doc._id),
  );

const checkName = (name: string): string => checkDisplayName(name, "Library names");

/** Libraries the account can see. */
export const list = query({
  args: {},
  returns: v.array(library),
  handler: async (ctx) => {
    const viewer = await authorize(ctx, "read");
    const visible = await visibleLibraryIds(ctx, viewer);
    const libraries = await ctx.db.query("libraries").collect();

    return Promise.all(
      libraries
        .filter((doc) => visible.has(doc._id))
        .map(async (doc) => presentLibrary(doc, await isLibraryScanning(ctx, doc._id))),
    );
  },
});

export const listDetails = query({
  args: {},
  returns: v.array(libraryDetail),
  handler: async (ctx) => {
    await authorize(ctx, "manage");
    const libraries = await ctx.db.query("libraries").collect();

    return Promise.all(libraries.map((doc) => detail(ctx, doc)));
  },
});

export const get = query({
  args: { libraryId: v.id("libraries") },
  returns: libraryDetail,
  handler: async (ctx, { libraryId }) => {
    await authorize(ctx, "manage");
    const doc = await ctx.db.get(libraryId);

    if (doc === null) return fail("not_found", "No such library");

    return detail(ctx, doc);
  },
});

export const create = mutation({
  args: {
    name: v.string(),
    kind: libraryKind,
    roots: v.array(v.string()),
    access: v.optional(libraryAccess),
  },
  returns: v.object({ libraryId: v.id("libraries"), jobId: v.id("jobs") }),
  handler: async (ctx, { name, kind, roots, access }) => {
    const viewer = await authorize(ctx, "manage");

    const libraryId = await ctx.db.insert("libraries", {
      name: checkName(name),
      kind,
      roots: await checkRoots(ctx, roots, null),
      access: access ?? "everyone",
      createdBy: viewer.userId,
      titleCount: 0,
      lastScanAt: null,
    });

    const jobId = await enqueueJob(ctx, { kind: "scan", libraryId, mode: "full" }, viewer.userId);

    return { libraryId, jobId };
  },
});

export const update = mutation({
  args: {
    libraryId: v.id("libraries"),
    name: v.optional(v.string()),
    roots: v.optional(v.array(v.string())),
    access: v.optional(libraryAccess),
    trickplay: v.optional(v.boolean()),
  },
  returns: libraryDetail,
  handler: async (ctx, { libraryId, name, roots, access, trickplay }) => {
    const viewer = await authorize(ctx, "manage");
    const current = await ctx.db.get(libraryId);

    if (current === null) return fail("not_found", "No such library");
    const nextRoots = roots === undefined ? current.roots : await checkRoots(ctx, roots, libraryId);

    await ctx.db.patch(libraryId, {
      name: name === undefined ? current.name : checkName(name),
      roots: nextRoots,
      access: access ?? current.access,
      trickplay: trickplay ?? current.trickplay,
    });

    if (roots !== undefined) {
      await enqueueJob(ctx, { kind: "scan", libraryId, mode: "full" }, viewer.userId);
    }

    // Turning thumbnails off stops the ones still queued for this library.
    if (trickplay === false && current.trickplay !== false) {
      await ctx.scheduler.runAfter(0, internal.libraries.cancelTrickplayPage, {
        libraryId,
        cursor: null,
      });
    }

    const updated = await ctx.db.get(libraryId);

    if (updated === null) return fail("not_found", "No such library");

    return detail(ctx, updated);
  },
});

/**
 * Removes a library from [movies]. Files on disk are untouched; its catalog is purged in batches,
 * which also end the playback and rooms on its titles.
 */
export const remove = mutation({
  args: { libraryId: v.id("libraries") },
  returns: ok,
  handler: async (ctx, { libraryId }) => {
    await authorize(ctx, "manage");
    const doc = await ctx.db.get(libraryId);

    if (doc === null) return fail("not_found", "No such library");

    const grants = await ctx.db
      .query("libraryGrants")
      .withIndex("by_library", (q) => q.eq("libraryId", libraryId))
      .collect();

    const jobs = await ctx.db
      .query("jobs")
      .withIndex("by_library_status", (q) => q.eq("libraryId", libraryId))
      .collect();

    const now = Date.now();

    await Promise.all([
      ...grants.map((grant) => ctx.db.delete(grant._id)),
      ...jobs.flatMap((job) =>
        job.status === "pending" || job.status === "running"
          ? [ctx.db.patch(job._id, { status: "cancelled" as const, finishedAt: now })]
          : [],
      ),
    ]);

    await ctx.db.delete(libraryId);
    await ctx.scheduler.runAfter(0, internal.maintenance.purgeLibrary, { libraryId });

    return { ok: true as const };
  },
});

export const scan = mutation({
  args: { libraryId: v.id("libraries"), mode: v.optional(scanMode) },
  returns: queuedJob,
  handler: async (ctx, { libraryId, mode }) => {
    const viewer = await authorize(ctx, "manage");

    if ((await ctx.db.get(libraryId)) === null) return fail("not_found", "No such library");

    const jobId = await enqueueJob(
      ctx,
      { kind: "scan", libraryId, mode: mode ?? "quick" },
      viewer.userId,
    );

    return { jobId };
  },
});

/** Files one `queueTrickplayPage` run looks at before it schedules the next page. */
const TRICKPLAY_PAGE = 200;

/**
 * Queues scrub thumbnails for every present file of a library that has none for its current
 * contents, including files whose last attempt failed. Large libraries are queued in pages in the
 * background, so this returns at once.
 */
export const generateTrickplay = mutation({
  args: { libraryId: v.id("libraries") },
  returns: ok,
  handler: async (ctx, { libraryId }) => {
    const viewer = await authorize(ctx, "manage");

    if ((await ctx.db.get(libraryId)) === null) return fail("not_found", "No such library");

    await ctx.scheduler.runAfter(0, internal.libraries.queueTrickplayPage, {
      libraryId,
      cursor: null,
      requestedBy: viewer.userId,
    });

    return { ok: true as const };
  },
});

/** One page of `generateTrickplay`; schedules the next page until the library is done. */
export const queueTrickplayPage = internalMutation({
  args: {
    libraryId: v.id("libraries"),
    cursor: v.union(v.string(), v.null()),
    requestedBy: v.id("users"),
  },
  returns: v.null(),
  handler: async (ctx, { libraryId, cursor, requestedBy }) => {
    if ((await ctx.db.get(libraryId)) === null) return null;

    const result = await ctx.db
      .query("mediaFiles")
      .withIndex("by_library_path", (q) => q.eq("libraryId", libraryId))
      .paginate({ numItems: TRICKPLAY_PAGE, cursor });

    await inSequence(result.page, (file) =>
      queueTrickplay(ctx, file, { retryFailed: true, requestedBy }),
    );

    if (!result.isDone) {
      await ctx.scheduler.runAfter(0, internal.libraries.queueTrickplayPage, {
        libraryId,
        cursor: result.continueCursor,
        requestedBy,
      });
    }

    return null;
  },
});

/** One page of cancelling a library's queued thumbnails, after they were turned off. */
export const cancelTrickplayPage = internalMutation({
  args: { libraryId: v.id("libraries"), cursor: v.union(v.string(), v.null()) },
  returns: v.null(),
  handler: async (ctx, { libraryId, cursor }) => {
    const doc = await ctx.db.get(libraryId);

    // Turned back on meanwhile: whatever is queued stays.
    if (doc === null || doc.trickplay !== false) return null;

    const result = await ctx.db
      .query("mediaFiles")
      .withIndex("by_library_path", (q) => q.eq("libraryId", libraryId))
      .paginate({ numItems: TRICKPLAY_PAGE, cursor });

    await inSequence(
      result.page.filter((file) => file.trickplay?.status === "pending"),
      (file) => forgetTrickplay(ctx, file),
    );

    if (!result.isDone) {
      await ctx.scheduler.runAfter(0, internal.libraries.cancelTrickplayPage, {
        libraryId,
        cursor: result.continueCursor,
      });
    }

    return null;
  },
});

const DEFAULT_FILE_PAGE = 50;

const MAX_FILE_PAGE = 100;

/** Unmatched titles per page; each brings its files, so pages stay well under the read limit. */
const UNMATCHED_TITLES_PER_PAGE = 20;

/** Most files listed per unmatched title, so a large unmatched show cannot exhaust a page. */
const FILES_PER_UNMATCHED_TITLE = 50;

/** Most missing files or unmatched titles counted for a summary; more read as this many. */
const SUMMARY_LIMIT = 1000;

/** A file with its title (overrides applied) and, for a show, its episode numbers. */
const presentLibraryFile = async (
  ctx: QueryCtx,
  file: Doc<"mediaFiles">,
  title: Doc<"titles">,
): Promise<Infer<typeof libraryFile>> => {
  const video = file.probe.video[0];
  const episode = file.episodeId === null ? null : await ctx.db.get(file.episodeId);

  return {
    id: file._id,
    path: file.path,
    sizeBytes: file.sizeBytes,
    durationMs: file.probe.durationMs,
    video:
      video === undefined
        ? null
        : { codec: video.codec, width: video.width, height: video.height, hdr: video.hdr },
    missing: file.missing,
    missingSince: file.missing ? (file.missingSince ?? null) : null,
    title: {
      id: title._id,
      kind: title.kind,
      name: title.overrides?.name ?? title.name,
      year: title.overrides?.year ?? title.year,
      matchStatus: title.matchStatus,
      externalIds: title.externalIds,
      poster: title.artwork.poster,
    },
    episode:
      episode === null
        ? null
        : { seasonNumber: episode.seasonNumber, episodeNumber: episode.episodeNumber },
  };
};

/** Presents files whose titles still exist, loading each title once. */
const presentFiles = async (
  ctx: QueryCtx,
  files: ReadonlyArray<Doc<"mediaFiles">>,
): Promise<Array<Infer<typeof libraryFile>>> => {
  const titleIds = [...new Set(files.map((file) => file.titleId))];

  const titles = new Map(
    (await Promise.all(titleIds.map((id) => ctx.db.get(id)))).flatMap((doc) =>
      doc === null ? [] : [[doc._id, doc] as const],
    ),
  );

  return Promise.all(
    files.flatMap((file) => {
      const title = titles.get(file.titleId);

      return title === undefined ? [] : [presentLibraryFile(ctx, file, title)];
    }),
  );
};

/**
 * A library's files for the admin file list, by path. `missing` pages through missing files;
 * `unmatched` pages through unmatched titles (20 at most) and lists up to 50 files of each, so a
 * page may hold more or fewer files than `limit`.
 */
export const files = query({
  args: {
    libraryId: v.id("libraries"),
    ...pageArgs,
    filter: v.optional(libraryFileFilter),
    titleId: v.optional(v.id("titles")),
  },
  returns: page(libraryFile),
  handler: async (ctx, { libraryId, cursor, limit, filter, titleId }) => {
    await authorize(ctx, "manage");
    const numItems = resultLimit(limit, DEFAULT_FILE_PAGE, MAX_FILE_PAGE);
    const paging = { numItems, cursor: cursor ?? null };

    if (titleId !== undefined) {
      const result = await ctx.db
        .query("mediaFiles")
        .withIndex("by_title", (q) => q.eq("titleId", titleId))
        .paginate(paging);

      return {
        items: await presentFiles(
          ctx,
          result.page.filter((file) => file.libraryId === libraryId),
        ),
        nextCursor: result.isDone ? null : result.continueCursor,
      };
    }

    if (filter === "unmatched") {
      const result = await ctx.db
        .query("titles")
        .withIndex("by_library_status", (q) =>
          q.eq("libraryId", libraryId).eq("matchStatus", "unmatched"),
        )
        .paginate({ ...paging, numItems: Math.min(numItems, UNMATCHED_TITLES_PER_PAGE) });

      const perTitle = await Promise.all(
        result.page.map((title) =>
          ctx.db
            .query("mediaFiles")
            .withIndex("by_title", (q) => q.eq("titleId", title._id))
            .take(FILES_PER_UNMATCHED_TITLE),
        ),
      );

      return {
        items: await presentFiles(ctx, perTitle.flat()),
        nextCursor: result.isDone ? null : result.continueCursor,
      };
    }

    const result =
      filter === "missing"
        ? await ctx.db
            .query("mediaFiles")
            .withIndex("by_library_missing", (q) =>
              q.eq("libraryId", libraryId).eq("missing", true),
            )
            .paginate(paging)
        : await ctx.db
            .query("mediaFiles")
            .withIndex("by_library_path", (q) => q.eq("libraryId", libraryId))
            .paginate(paging);

    return {
      items: await presentFiles(ctx, result.page),
      nextCursor: result.isDone ? null : result.continueCursor,
    };
  },
});

/** How many of a library's files are missing (and since when) and how many titles are unmatched. */
export const fileSummary = query({
  args: { libraryId: v.id("libraries") },
  returns: libraryFileSummary,
  handler: async (ctx, { libraryId }) => {
    await authorize(ctx, "manage");

    const [missing, unmatched] = await Promise.all([
      ctx.db
        .query("mediaFiles")
        .withIndex("by_library_missing", (q) => q.eq("libraryId", libraryId).eq("missing", true))
        .take(SUMMARY_LIMIT),
      ctx.db
        .query("titles")
        .withIndex("by_library_status", (q) =>
          q.eq("libraryId", libraryId).eq("matchStatus", "unmatched"),
        )
        .take(SUMMARY_LIMIT),
    ]);

    const since = missing.flatMap((file) =>
      file.missingSince === undefined ? [] : [file.missingSince],
    );

    return {
      missingFiles: missing.length,
      missingSince: since.length === 0 ? null : Math.min(...since),
      unmatchedTitles: unmatched.length,
    };
  },
});
