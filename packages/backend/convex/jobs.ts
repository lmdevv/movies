import { v } from "convex/values";

import { mutation, query } from "./_generated/server";
import { fail } from "./lib/errors";
import { presentJob } from "./lib/present";
import { job, jobKind, jobStatus, ok } from "./lib/validators";
import { authorize } from "./lib/viewer";

export const list = query({
  args: {
    kind: v.optional(jobKind),
    status: v.optional(jobStatus),
    limit: v.optional(v.number()),
  },
  returns: v.array(job),
  handler: async (ctx, { kind, status, limit }) => {
    await authorize(ctx, "manage");
    const count = Math.min(Math.max(1, Math.floor(limit ?? 50)), 100);
    const jobs = ctx.db.query("jobs");

    const indexed =
      kind !== undefined && status !== undefined
        ? jobs.withIndex("by_kind_status", (q) => q.eq("kind", kind).eq("status", status))
        : status === undefined
          ? jobs
          : jobs.withIndex("by_status", (q) => q.eq("status", status));

    const docs = await indexed
      .order("desc")
      .take(kind !== undefined && status === undefined ? 500 : count);

    return docs
      .filter((doc) => kind === undefined || doc.kind === kind)
      .slice(0, count)
      .map(presentJob);
  },
});

export const get = query({
  args: { jobId: v.id("jobs") },
  returns: job,
  handler: async (ctx, { jobId }) => {
    await authorize(ctx, "manage");
    const doc = await ctx.db.get(jobId);

    if (doc === null) return fail("not_found", "No such job");

    return presentJob(doc);
  },
});

/** Cancels a job. A running job's worker sees `cancelled` on its next lease renewal and stops. */
export const cancel = mutation({
  args: { jobId: v.id("jobs") },
  returns: ok,
  handler: async (ctx, { jobId }) => {
    await authorize(ctx, "manage");
    const doc = await ctx.db.get(jobId);

    if (doc === null) return fail("not_found", "No such job");

    if (doc.status === "pending" || doc.status === "running") {
      await ctx.db.patch(jobId, { status: "cancelled", finishedAt: Date.now() });
    }

    return { ok: true as const };
  },
});
