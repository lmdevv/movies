import { v } from "convex/values";

import { query } from "./_generated/server";
import { canSee, loadAudience } from "./lib/access";
import { inSequence } from "./lib/catalog";
import { collection } from "./lib/migrationValidators";
import { presentTitleCard } from "./lib/present";
import { authorize } from "./lib/viewer";

/** Most collections the list shows, and most titles each one shows. */
const LIST_LIMIT = 200;

const TITLE_LIMIT = 200;

/** Most members read across all collections, so the query stays inside Convex's read limit. */
const MEMBER_BUDGET = 5000;

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
      const members =
        budget <= 0
          ? []
          : await ctx.db
              .query("collectionItems")
              .withIndex("by_collection_position", (q) => q.eq("collectionId", doc._id))
              .take(Math.min(TITLE_LIMIT, budget));

      budget -= members.length;
      const titles = await Promise.all(members.map((member) => ctx.db.get(member.titleId)));

      return {
        id: doc._id,
        name: doc.name,
        titles: titles.flatMap((title) =>
          title !== null && canSee(audience, title) ? [presentTitleCard(title)] : [],
        ),
      };
    });

    return listed.filter((entry) => entry.titles.length > 0);
  },
});
