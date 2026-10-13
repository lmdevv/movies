import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { fail } from "./lib/errors";
import { presentJob } from "./lib/present";
import { job, jobKind, jobStatus, ok } from "./lib/validators";
import { authorize } from "./lib/viewer";
import type { Viewer } from "./lib/viewer";

/** Job kinds of admin features (backups and migrations); `manage` alone cannot see or cancel them. */
const ADMIN_JOB_KINDS: ReadonlySet<Doc<"jobs">["kind"]> = new Set(["backup", "migration"]);

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

    const count = Math.min(Math.max(1, Math.floor(limit ?? 50)), 100);
    // Reads further when filtering by kind afterwards, so a page is not cut short.
    const filtered = (kind !== undefined && status === undefined) || !viewer.scopes.has("admin");
    const jobs = ctx.db.query("jobs");

    const indexed =
      kind !== undefined && status !== undefined
        ? jobs.withIndex("by_kind_status", (q) => q.eq("kind", kind).eq("status", status))
        : status === undefined
          ? jobs
          : jobs.withIndex("by_status", (q) => q.eq("status", status));

    const docs = await indexed.order("desc").take(filtered ? 500 : count);

    return docs
      .filter((doc) => (kind === undefined || doc.kind === kind) && mayHandle(viewer, doc.kind))
      .slice(0, count)
      .map(presentJob);
  },
});

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
    }

    return { ok: true as const };
  },
});
