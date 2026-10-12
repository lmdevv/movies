import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import type { QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { visibleLibraryIds } from "./lib/access";
import { fail } from "./lib/errors";
import { enqueueJob } from "./lib/jobs";
import { checkRoots } from "./lib/roots";
import { presentLibrary, presentLibraryDetail } from "./lib/present";
import {
  library,
  libraryAccess,
  libraryDetail,
  libraryKind,
  ok,
  queuedJob,
  scanMode,
} from "./lib/validators";
import { authorize } from "./lib/viewer";

const isScanning = async (ctx: QueryCtx, libraryId: Id<"libraries">): Promise<boolean> => {
  const statuses = ["pending", "running"] as const;

  const active = await Promise.all(
    statuses.map((status) =>
      ctx.db
        .query("jobs")
        .withIndex("by_library_status", (q) => q.eq("libraryId", libraryId).eq("status", status))
        .first(),
    ),
  );

  return active.some((job) => job !== null);
};

const grantedUsers = async (ctx: QueryCtx, libraryId: Id<"libraries">) => {
  const grants = await ctx.db
    .query("libraryGrants")
    .withIndex("by_library", (q) => q.eq("libraryId", libraryId))
    .collect();

  return grants.map((grant) => grant.userId);
};

const detail = async (ctx: QueryCtx, doc: Doc<"libraries">) =>
  presentLibraryDetail(doc, await isScanning(ctx, doc._id), await grantedUsers(ctx, doc._id));

const checkName = (name: string): string => {
  const trimmed = name.trim();

  if (trimmed.length === 0 || trimmed.length > 80) {
    return fail("invalid_args", "Library names have 1 to 80 characters");
  }

  return trimmed;
};

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
        .map(async (doc) => presentLibrary(doc, await isScanning(ctx, doc._id))),
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
  },
  returns: libraryDetail,
  handler: async (ctx, { libraryId, name, roots, access }) => {
    const viewer = await authorize(ctx, "manage");
    const current = await ctx.db.get(libraryId);

    if (current === null) return fail("not_found", "No such library");
    const nextRoots = roots === undefined ? current.roots : await checkRoots(ctx, roots, libraryId);

    await ctx.db.patch(libraryId, {
      name: name === undefined ? current.name : checkName(name),
      roots: nextRoots,
      access: access ?? current.access,
    });

    if (roots !== undefined) {
      await enqueueJob(ctx, { kind: "scan", libraryId, mode: "full" }, viewer.userId);
    }

    const updated = await ctx.db.get(libraryId);

    if (updated === null) return fail("not_found", "No such library");

    return detail(ctx, updated);
  },
});

/** Removes a library from [movies]. Files on disk are untouched; its catalog is purged in batches. */
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
