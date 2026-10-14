import { v } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import { mutation } from "./_generated/server";
import { checkOverrides } from "./lib/bounds";
import { writeOverrides } from "./lib/catalog";
import { fail } from "./lib/errors";
import { enqueueJob } from "./lib/jobs";
import { metadataField, metadataOverrides, ok, queuedJob } from "./lib/validators";
import { authorize } from "./lib/viewer";

/**
 * Matches a title to a TMDB entry. The media service's metadata job fetches it, writes it, and
 * marks the match manual so rescans keep it.
 */
export const fixMatch = mutation({
  args: { titleId: v.id("titles"), provider: v.literal("tmdb"), providerId: v.string() },
  returns: queuedJob,
  handler: async (ctx, { titleId, provider, providerId }) => {
    const viewer = await authorize(ctx, "manage");

    if ((await ctx.db.get(titleId)) === null) return fail("not_found", "No such title");

    if (providerId.trim().length === 0) return fail("invalid_args", "Choose a match");

    const jobId = await enqueueJob(
      ctx,
      { kind: "metadata", titleId, match: { provider, providerId: providerId.trim() } },
      viewer.userId,
    );

    return { jobId };
  },
});

/**
 * Queues a metadata job that fetches a title's details again from its current match. Requires
 * `manage` scope. A refresh fills credits nobody wrote yet but keeps the ones a scan wrote.
 */
export const refresh = mutation({
  args: { titleId: v.id("titles") },
  returns: queuedJob,
  handler: async (ctx, { titleId }) => {
    const viewer = await authorize(ctx, "manage");

    if ((await ctx.db.get(titleId)) === null) return fail("not_found", "No such title");

    return {
      jobId: await enqueueJob(ctx, { kind: "metadata", titleId, match: null }, viewer.userId),
    };
  },
});

type Overrides = NonNullable<Doc<"titles">["overrides"]>;

/** Sets and clears a title's overrides. Scans never overwrite them. */
export const edit = mutation({
  args: {
    titleId: v.id("titles"),
    set: metadataOverrides,
    clear: v.optional(v.array(metadataField)),
  },
  returns: ok,
  handler: async (ctx, { titleId, set, clear }) => {
    await authorize(ctx, "manage");
    const title = await ctx.db.get(titleId);

    if (title === null) return fail("not_found", "No such title");

    const merged: Overrides = { ...title.overrides, ...checkOverrides(set) };

    for (const field of clear ?? []) delete merged[field];

    await writeOverrides(ctx, title, merged);

    return { ok: true as const };
  },
});
