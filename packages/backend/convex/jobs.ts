import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { resultLimit } from "./lib/bounds";
import { fail } from "./lib/errors";
import { settleTrickplay } from "./lib/trickplay";
import { presentJob } from "./lib/present";
import { job, jobKind, jobStatus, ok } from "./lib/validators";
import { authorize } from "./lib/viewer";
import type { Viewer } from "./lib/viewer";

/** Job kinds of admin features (backups and migrations); `manage` alone cannot see or cancel them. */
const ADMIN_JOB_KINDS: ReadonlySet<Doc<"jobs">["kind"]> = new Set(["backup", "migration"]);

/** Jobs `jobs.list` reads per batch while filtering, and at most in all. */
const JOBS_BATCH = 100;

const JOBS_READ_LIMIT = 2000;

const mayHandle = (viewer: Viewer, kind: Doc<"jobs">["kind"]): boolean =>
  viewer.scopes.has("admin") || !ADMIN_JOB_KINDS.has(kind);

/** Loads a job the viewer may handle; an admin job without `admin` is refused. */
const loadJob = async (ctx: QueryCtx, viewer: Viewer, jobId: Id<"jobs">): Promise<Doc<"jobs">> => {
  const doc = await ctx.db.get(jobId);

  if (doc === null) return fail("not_found", "No such job");

  if (!mayHandle(viewer, doc.kind)) {
    return fail("forbidden", `This session lacks the admin scope ${doc.kind} jobs need`);
  }

  return doc;
};

/**
 * Jobs newest first, filtered by kind and status. Requires `manage` scope; backup and migration
 * jobs also need `admin` and are left out without it. Without both filters at most 2000 jobs are
 * read, so a page can come back short.
 */
export const list = query({
  args: {
    kind: v.optional(jobKind),
    status: v.optional(jobStatus),
    limit: v.optional(v.number()),
  },
  returns: v.array(job),
  handler: async (ctx, { kind, status, limit }) => {
    const viewer = await authorize(ctx, "manage");

    if (kind !== undefined && !mayHandle(viewer, kind)) {
      return fail("forbidden", `This session lacks the admin scope ${kind} jobs need`);
    }

    const count = resultLimit(limit, 50, 100);
    const jobs = ctx.db.query("jobs");

    if (kind !== undefined && status !== undefined) {
      const docs = await jobs
        .withIndex("by_kind_status", (q) => q.eq("kind", kind).eq("status", status))
        .order("desc")
        .take(count);

      return docs.map(presentJob);
    }

    const wanted = (doc: Doc<"jobs">): boolean =>
      (kind === undefined || doc.kind === kind) && mayHandle(viewer, doc.kind);

    // Newest first, older than `before`; filtered in memory by kind and by what the viewer may see.
    const olderThan = (before: number | null, take: number) =>
      (status === undefined
        ? jobs.withIndex("by_creation_time", (q) =>
            before === null ? q : q.lt("_creationTime", before),
          )
        : jobs.withIndex("by_status", (q) =>
            before === null
              ? q.eq("status", status)
              : q.eq("status", status).lt("_creationTime", before),
          )
      )
        .order("desc")
        .take(take);

    /** Reads batches until `count` jobs match, the jobs run out, or `JOBS_READ_LIMIT` is read. */
    const collect = async (
      before: number | null,
      found: ReadonlyArray<Doc<"jobs">>,
      read: number,
    ): Promise<ReadonlyArray<Doc<"jobs">>> => {
      const batch = await olderThan(before, JOBS_BATCH);
      const matched = [...found, ...batch.filter(wanted)];
      const last = batch.at(-1);

      return matched.length >= count ||
        last === undefined ||
        batch.length < JOBS_BATCH ||
        read + batch.length >= JOBS_READ_LIMIT
        ? matched
        : collect(last._creationTime, matched, read + batch.length);
    };

    return (await collect(null, [], 0)).slice(0, count).map(presentJob);
  },
});

/**
 * One job with its progress and error. Requires `manage` scope, plus `admin` for backup and
 * migration jobs.
 */
export const get = query({
  args: { jobId: v.id("jobs") },
  returns: job,
  handler: async (ctx, { jobId }) => {
    const viewer = await authorize(ctx, "manage");

    return presentJob(await loadJob(ctx, viewer, jobId));
  },
});

/** Cancels a job. A running job's worker sees `cancelled` on its next lease renewal and stops. */
export const cancel = mutation({
  args: { jobId: v.id("jobs") },
  returns: ok,
  handler: async (ctx, { jobId }) => {
    const viewer = await authorize(ctx, "manage");
    const doc = await loadJob(ctx, viewer, jobId);

    if (doc.status === "pending" || doc.status === "running") {
      await ctx.db.patch(jobId, { status: "cancelled", finishedAt: Date.now() });
      await settleTrickplay(ctx, doc, "cancelled");
    }

    return { ok: true as const };
  },
});
