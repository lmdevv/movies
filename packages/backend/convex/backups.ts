import { v } from "convex/values";

import { mutation, query } from "./_generated/server";
import { enqueueJob } from "./lib/jobs";
import { createdAt } from "./lib/present";
import { backup, queuedJob } from "./lib/validators";
import { authorize } from "./lib/viewer";

export const list = query({
  args: {},
  returns: v.array(backup),
  handler: async (ctx) => {
    await authorize(ctx, "admin");
    const backups = await ctx.db.query("backups").order("desc").take(200);

    return backups.map((doc) => ({
      id: doc._id,
      fileName: doc.fileName,
      sizeBytes: doc.sizeBytes,
      trigger: doc.trigger,
      createdAt: createdAt(doc),
    }));
  },
});

/** Queues a backup for the media service, which runs `convex export` into its backup folder. */
export const run = mutation({
  args: {},
  returns: queuedJob,
  handler: async (ctx) => {
    const viewer = await authorize(ctx, "admin");

    return { jobId: await enqueueJob(ctx, { kind: "backup", trigger: "manual" }, viewer.userId) };
  },
});
