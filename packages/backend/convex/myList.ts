import { v } from "convex/values";

import { mutation, query } from "./_generated/server";
import { canSee, loadAudience, loadVisibleTitle } from "./lib/access";
import { presentTitleCard } from "./lib/present";
import { ok, titleCard } from "./lib/validators";
import { authorize } from "./lib/viewer";

/** Most titles a profile's list shows. */
const LIST_LIMIT = 500;

export const list = query({
  args: { profileId: v.id("profiles") },
  returns: v.array(titleCard),
  handler: async (ctx, { profileId }) => {
    const viewer = await authorize(ctx, "read");
    const audience = await loadAudience(ctx, viewer, profileId);

    const entries = await ctx.db
      .query("myList")
      .withIndex("by_profile_added", (q) => q.eq("profileId", profileId))
      .order("desc")
      .take(LIST_LIMIT);

    const titles = await Promise.all(entries.map((entry) => ctx.db.get(entry.titleId)));

    return titles.flatMap((title) =>
      title !== null && canSee(audience, title) ? [presentTitleCard(title)] : [],
    );
  },
});

export const add = mutation({
  args: { profileId: v.id("profiles"), titleId: v.id("titles") },
  returns: ok,
  handler: async (ctx, { profileId, titleId }) => {
    const viewer = await authorize(ctx, "play");
    await loadVisibleTitle(ctx, await loadAudience(ctx, viewer, profileId), titleId);

    const existing = await ctx.db
      .query("myList")
      .withIndex("by_profile_title", (q) => q.eq("profileId", profileId).eq("titleId", titleId))
      .unique();

    if (existing === null)
      await ctx.db.insert("myList", { profileId, titleId, addedAt: Date.now() });

    return { ok: true as const };
  },
});

export const remove = mutation({
  args: { profileId: v.id("profiles"), titleId: v.id("titles") },
  returns: ok,
  handler: async (ctx, { profileId, titleId }) => {
    const viewer = await authorize(ctx, "play");
    await loadAudience(ctx, viewer, profileId);

    const existing = await ctx.db
      .query("myList")
      .withIndex("by_profile_title", (q) => q.eq("profileId", profileId).eq("titleId", titleId))
      .unique();

    if (existing !== null) await ctx.db.delete(existing._id);

    return { ok: true as const };
  },
});
