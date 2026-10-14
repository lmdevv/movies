import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { resultLimit } from "./lib/bounds";
import { canSee, loadAudience, loadVisibleTitle } from "./lib/access";
import type { Audience } from "./lib/access";
import { fail } from "./lib/errors";
import { findProgress, presentEpisode, presentProgress, presentTitleCard } from "./lib/present";
import { continueWatchingItem, historyEntry, ok, page, pageArgs } from "./lib/validators";
import { continueWatching as continueWatchingRows, writeProgress } from "./lib/viewing";
import { authorize } from "./lib/viewer";

/**
 * Continue watching for a profile, most recent first: items in progress and the next episode of
 * shows whose latest episode is finished.
 */
export const continueWatching = query({
  args: { profileId: v.id("profiles") },
  returns: v.array(continueWatchingItem),
  handler: async (ctx, { profileId }) => {
    const viewer = await authorize(ctx, "read");

    return continueWatchingRows(ctx, await loadAudience(ctx, viewer, profileId));
  },
});

/**
 * A profile's watch history, most recently played first. Titles the profile may no longer see are
 * dropped after paging, so a page can hold fewer items than the limit.
 */
export const list = query({
  args: { profileId: v.id("profiles"), ...pageArgs },
  returns: page(historyEntry),
  handler: async (ctx, { profileId, cursor, limit }) => {
    const viewer = await authorize(ctx, "read");
    const audience = await loadAudience(ctx, viewer, profileId);

    const result = await ctx.db
      .query("watchProgress")
      .withIndex("by_profile_played", (q) => q.eq("profileId", profileId))
      .order("desc")
      .paginate({
        numItems: resultLimit(limit, 50, 100),
        cursor: cursor ?? null,
      });

    const entries = await Promise.all(
      result.page.map(async (row) => {
        const title = await ctx.db.get(row.titleId);

        if (title === null || !canSee(audience, title)) return [];
        const episode = row.episodeId === null ? null : await ctx.db.get(row.episodeId);

        return [
          {
            title: presentTitleCard(title),
            episode: episode === null ? null : presentEpisode(episode, row),
            progress: presentProgress(row),
            lastPlayedAt: row.lastPlayedAt,
          },
        ];
      }),
    );

    return { items: entries.flat(), nextCursor: result.isDone ? null : result.continueCursor };
  },
});

/** The movie, the one episode, or every episode of a show a watched mark applies to. */
const markTargets = async (
  ctx: MutationCtx,
  audience: Audience,
  titleId: Id<"titles">,
  episodeId: Id<"episodes"> | undefined,
): Promise<{
  readonly title: Doc<"titles">;
  readonly episodes: ReadonlyArray<Doc<"episodes"> | null>;
}> => {
  const title = await loadVisibleTitle(ctx, audience, titleId);

  if (title.kind === "movie") return { title, episodes: [null] };

  if (episodeId !== undefined) {
    const episode = await ctx.db.get(episodeId);

    if (episode?.titleId !== titleId) return fail("not_found", "No such episode");

    return { title, episodes: [episode] };
  }

  const episodes = await ctx.db
    .query("episodes")
    .withIndex("by_title_order", (q) => q.eq("titleId", titleId))
    .collect();

  return { title, episodes };
};

/**
 * Marks a movie, one episode, or with no episode every episode of a show as watched, at the end of
 * each item. Requires `play` scope.
 */
export const markWatched = mutation({
  args: {
    profileId: v.id("profiles"),
    titleId: v.id("titles"),
    episodeId: v.optional(v.id("episodes")),
  },
  returns: ok,
  handler: async (ctx, { profileId, titleId, episodeId }) => {
    const viewer = await authorize(ctx, "play");
    const audience = await loadAudience(ctx, viewer, profileId);
    const { title, episodes } = await markTargets(ctx, audience, titleId, episodeId);
    const now = Date.now();

    await Promise.all(
      episodes.map(async (episode) => {
        const durationMs = episode?.runtimeMs ?? title.runtimeMs ?? 0;

        await writeProgress(ctx, {
          profileId,
          titleId,
          episodeId: episode?._id ?? null,
          fileId: null,
          positionMs: durationMs,
          durationMs,
          watched: true,
          playedAt: now,
          session: null,
        });
      }),
    );

    return { ok: true as const };
  },
});

/**
 * Clears a profile's progress for a movie, one episode, or every episode of a show, removing those
 * items from history and continue watching.
 */
export const markUnwatched = mutation({
  args: {
    profileId: v.id("profiles"),
    titleId: v.id("titles"),
    episodeId: v.optional(v.id("episodes")),
  },
  returns: ok,
  handler: async (ctx, { profileId, titleId, episodeId }) => {
    const viewer = await authorize(ctx, "play");
    const audience = await loadAudience(ctx, viewer, profileId);
    const { episodes } = await markTargets(ctx, audience, titleId, episodeId);

    const rows = await Promise.all(
      episodes.map((episode) => findProgress(ctx, profileId, titleId, episode?._id ?? null)),
    );

    await Promise.all(rows.flatMap((row) => (row === null ? [] : [ctx.db.delete(row._id)])));

    return { ok: true as const };
  },
});
