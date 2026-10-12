import { v } from "convex/values";

import { query } from "./_generated/server";
import { presentJob } from "./lib/present";
import { job } from "./lib/validators";
import { authorize } from "./lib/viewer";

/** Migration jobs, newest first, with the progress the media service reports. */
export const status = query({
  args: {},
  returns: v.array(job),
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

    return groups
      .flat()
      .toSorted((left, right) => right._creationTime - left._creationTime)
      .map(presentJob);
  },
});
