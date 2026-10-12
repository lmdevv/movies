import { v } from "convex/values";

import { query } from "./_generated/server";
import { canSee, loadAudience } from "./lib/access";
import { collection } from "./lib/migrationValidators";
import { presentTitleCard } from "./lib/present";
import { authorize } from "./lib/viewer";

/** Most collections the list shows, and most titles each one shows. */
const LIST_LIMIT = 200;

const TITLE_LIMIT = 200;

/** Collections in name order with the titles the profile may see; empty ones are left out. */
export const list = query({
  args: { profileId: v.id("profiles") },
  returns: v.array(collection),
  handler: async (ctx, { profileId }) => {
    const viewer = await authorize(ctx, "read");
    const audience = await loadAudience(ctx, viewer, profileId);
    const collections = await ctx.db.query("collections").withIndex("by_sort").take(LIST_LIMIT);

    const listed = await Promise.all(
      collections.map(async (doc) => {
        const members = await ctx.db
          .query("collectionItems")
          .withIndex("by_collection_position", (q) => q.eq("collectionId", doc._id))
          .take(TITLE_LIMIT);

        const titles = await Promise.all(members.map((member) => ctx.db.get(member.titleId)));

        return {
          id: doc._id,
          name: doc.name,
          titles: titles.flatMap((title) =>
            title !== null && canSee(audience, title) ? [presentTitleCard(title)] : [],
          ),
        };
      }),
    );

    return listed.filter((entry) => entry.titles.length > 0);
  },
});
