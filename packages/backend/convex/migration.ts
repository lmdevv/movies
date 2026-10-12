import { v } from "convex/values";

import { query } from "./_generated/server";
import { migrationRun } from "./lib/migrationValidators";
import { presentJob } from "./lib/present";
import { authorize } from "./lib/viewer";

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

/** Migration jobs, newest first, with their phase and what they imported so far. */
export const status = query({
  args: {},
  returns: v.array(migrationRun),
  handler: async (ctx) => {
    await authorize(ctx, "admin");
    const statuses = ["pending", "running", "succeeded", "failed", "cancelled"] as const;

    const groups = await Promise.all(
      statuses.map((jobStatus) =>
        ctx.db
          .query("jobs")
          .withIndex("by_kind_status", (q) => q.eq("kind", "migration").eq("status", jobStatus))
          .order("desc")
          .take(20),
      ),
    );

    const jobs = groups.flat().toSorted((left, right) => right._creationTime - left._creationTime);

    return Promise.all(
      jobs.map(async (job) => {
        const row = await ctx.db
          .query("migrations")
          .withIndex("by_job", (q) => q.eq("jobId", job._id))
          .unique();

        const payload =
          job.payload.kind === "migration"
            ? job.payload
            : { source: "jellyfin" as const, serverName: "" };

        return {
          job: presentJob(job),
          source: row?.source ?? payload.source,
          serverName: row?.serverName ?? payload.serverName,
          phase: row?.checkpoint.phase ?? ("libraries" as const),
          imported: row?.imported ?? NOTHING_IMPORTED,
        };
      }),
    );
  },
});
