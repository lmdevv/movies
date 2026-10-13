import { v } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import { query } from "./_generated/server";
import type { Audience } from "./lib/access";
import { canSee, loadAudience } from "./lib/access";
import { inSequence } from "./lib/catalog";
import { fail } from "./lib/errors";
import { collection } from "./lib/migrationValidators";
import { presentTitleCard } from "./lib/present";
import type { ReadCtx } from "./lib/viewer";
import { authorize } from "./lib/viewer";

/** Most collections the list shows, and most titles each one shows. */
const LIST_LIMIT = 200;

const TITLE_LIMIT = 200;

/** Most members read across all collections, so the query stays inside Convex's read limit. */
const MEMBER_BUDGET = 5000;

/** A collection with up to `limit` of its members that the profile may see, in order. */
const presentCollection = async (
  ctx: ReadCtx,
  audience: Audience,
  doc: Doc<"collections">,
  limit: number,
) => {
  const members =
    limit <= 0
      ? []
      : await ctx.db
          .query("collectionItems")
          .withIndex("by_collection_position", (q) => q.eq("collectionId", doc._id))
          .take(limit);

  const titles = await Promise.all(members.map((member) => ctx.db.get(member.titleId)));
  const seen = new Set<string>();

  return {
    read: members.length,
    collection: {
      id: doc._id,
      name: doc.name,
      overview: doc.overview ?? null,
      artwork: { poster: doc.poster ?? null, backdrop: doc.backdrop ?? null },
      titles: titles.flatMap((title) => {
        if (title === null || !canSee(audience, title) || seen.has(title._id)) return [];
        seen.add(title._id);

        return [presentTitleCard(title)];
      }),
    },
  };
};

/**
 * Collections in name order with the titles the profile may see; empty ones are left out. Members
 * are read up to a shared budget, so later collections may show fewer titles in a huge catalog.
 */
export const list = query({
  args: { profileId: v.id("profiles") },
  returns: v.array(collection),
  handler: async (ctx, { profileId }) => {
    const viewer = await authorize(ctx, "read");
    const audience = await loadAudience(ctx, viewer, profileId);
    const collections = await ctx.db.query("collections").withIndex("by_sort").take(LIST_LIMIT);

    let budget = MEMBER_BUDGET;

    const listed = await inSequence(collections, async (doc) => {
      const presented = await presentCollection(ctx, audience, doc, Math.min(TITLE_LIMIT, budget));

      budget -= presented.read;

      return presented.collection;
    });

    return listed.filter((entry) => entry.titles.length > 0);
  },
});

/** One collection with the titles the profile may see; one with none looks missing. */
export const get = query({
  args: { profileId: v.id("profiles"), collectionId: v.id("collections") },
  returns: collection,
  handler: async (ctx, { profileId, collectionId }) => {
    const viewer = await authorize(ctx, "read");
    const audience = await loadAudience(ctx, viewer, profileId);
    const doc = await ctx.db.get(collectionId);

    if (doc === null) return fail("not_found", "No such collection");
    const { collection: presented } = await presentCollection(ctx, audience, doc, TITLE_LIMIT);

    if (presented.titles.length === 0) return fail("not_found", "No such collection");

    return presented;
  },
});
