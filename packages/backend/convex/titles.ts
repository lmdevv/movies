/**
 * Browsing for one profile. Every result passes through the profile's audience: titles in
 * libraries the account cannot see, or rated above a limited profile's age, never appear and look
 * missing when asked for directly.
 */
import { v } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import { query } from "./_generated/server";
import { canSee, loadAudience, loadVisibleTitle } from "./lib/access";
import {
  findProgress,
  presentEpisode,
  presentEpisodeFor,
  presentMediaFile,
  presentProgress,
  presentTitleCard,
} from "./lib/present";
import {
  episode,
  home as homeResult,
  page,
  pageArgs,
  titleCard,
  titleDetail,
  titleKind,
  titleSort,
} from "./lib/validators";
import { continueWatching, upNextEpisode, visibleTitles } from "./lib/viewing";
import { authorize } from "./lib/viewer";

/** Titles read per row of the home screen before filtering. */
const ROW_SCAN = 200;

const ROW_LIMIT = 20;

const DEFAULT_PAGE = 50;

const MAX_PAGE = 100;

export const home = query({
  args: { profileId: v.id("profiles") },
  returns: homeResult,
  handler: async (ctx, { profileId }) => {
    const viewer = await authorize(ctx, "read");
    const audience = await loadAudience(ctx, viewer, profileId);

    const recent = async (kind: Doc<"titles">["kind"]) =>
      visibleTitles(
        audience,
        await ctx.db
          .query("titles")
          .withIndex("by_kind_added", (q) => q.eq("kind", kind))
          .order("desc")
          .take(ROW_SCAN),
        ROW_LIMIT,
      );

    const [movies, shows] = await Promise.all([recent("movie"), recent("show")]);

    const listed = await ctx.db
      .query("myList")
      .withIndex("by_profile_added", (q) => q.eq("profileId", profileId))
      .order("desc")
      .take(ROW_SCAN);

    const listedTitles = await Promise.all(listed.map((entry) => ctx.db.get(entry.titleId)));

    const featured = [...movies, ...shows]
      .filter((title) => title.artwork.backdrop !== null && title.presentFileCount > 0)
      .toSorted((left, right) => right.addedAt - left.addedAt)[0];

    return {
      featured: featured === undefined ? null : presentTitleCard(featured),
      continueWatching: await continueWatching(ctx, audience),
      myList: listedTitles
        .flatMap((title) => (title !== null && canSee(audience, title) ? [title] : []))
        .slice(0, ROW_LIMIT)
        .map(presentTitleCard),
      recentlyAddedMovies: movies.map(presentTitleCard),
      recentlyAddedShows: shows.map(presentTitleCard),
    };
  },
});

export const list = query({
  args: {
    profileId: v.id("profiles"),
    ...pageArgs,
    kind: v.optional(titleKind),
    libraryId: v.optional(v.id("libraries")),
    sort: v.optional(titleSort),
  },
  returns: page(titleCard),
  handler: async (ctx, { profileId, cursor, limit, kind, libraryId, sort }) => {
    const viewer = await authorize(ctx, "read");
    const audience = await loadAudience(ctx, viewer, profileId);
    const numItems = Math.min(Math.max(1, Math.floor(limit ?? DEFAULT_PAGE)), MAX_PAGE);
    const order = sort ?? "name";
    const titles = ctx.db.query("titles");

    const indexed =
      kind === undefined
        ? order === "name"
          ? titles.withIndex("by_sort")
          : order === "added"
            ? titles.withIndex("by_added")
            : titles.withIndex("by_year")
        : order === "name"
          ? titles.withIndex("by_kind_sort", (q) => q.eq("kind", kind))
          : order === "added"
            ? titles.withIndex("by_kind_added", (q) => q.eq("kind", kind))
            : titles.withIndex("by_kind_year", (q) => q.eq("kind", kind));

    const result = await indexed
      .order(order === "name" ? "asc" : "desc")
      .paginate({ numItems, cursor: cursor ?? null });

    return {
      items: result.page
        .filter(
          (title) =>
            canSee(audience, title) && (libraryId === undefined || title.libraryId === libraryId),
        )
        .map(presentTitleCard),
      nextCursor: result.isDone ? null : result.continueCursor,
    };
  },
});

export const search = query({
  args: { profileId: v.id("profiles"), query: v.string(), limit: v.optional(v.number()) },
  returns: v.array(titleCard),
  handler: async (ctx, { profileId, query: text, limit }) => {
    const viewer = await authorize(ctx, "read");
    const audience = await loadAudience(ctx, viewer, profileId);
    const wanted = Math.min(Math.max(1, Math.floor(limit ?? 20)), 50);

    if (text.trim().length === 0) return [];

    const matches = await ctx.db
      .query("titles")
      .withSearchIndex("search_text", (q) => q.search("searchText", text.trim()))
      .take(ROW_SCAN);

    return visibleTitles(audience, matches, wanted).map(presentTitleCard);
  },
});

export const get = query({
  args: { profileId: v.id("profiles"), titleId: v.id("titles") },
  returns: titleDetail,
  handler: async (ctx, { profileId, titleId }) => {
    const viewer = await authorize(ctx, "read");
    const audience = await loadAudience(ctx, viewer, profileId);
    const title = await loadVisibleTitle(ctx, audience, titleId);

    const seasons = await ctx.db
      .query("seasons")
      .withIndex("by_title_number", (q) => q.eq("titleId", titleId))
      .collect();

    const files =
      title.kind === "movie"
        ? await ctx.db
            .query("mediaFiles")
            .withIndex("by_title", (q) => q.eq("titleId", titleId))
            .collect()
        : [];

    const progress =
      title.kind === "movie" ? await findProgress(ctx, profileId, titleId, null) : null;

    const next = title.kind === "show" ? await upNextEpisode(ctx, profileId, titleId) : null;

    const listed = await ctx.db
      .query("myList")
      .withIndex("by_profile_title", (q) => q.eq("profileId", profileId).eq("titleId", titleId))
      .unique();

    return {
      ...presentTitleCard(title),
      libraryId: title.libraryId,
      sortName: title.overrides?.sortName ?? title.sortName,
      overview: title.overrides?.overview ?? title.overview,
      tagline: title.tagline,
      externalIds: title.externalIds,
      matchStatus: title.matchStatus,
      seasons: seasons.map((season) => ({
        id: season._id,
        seasonNumber: season.seasonNumber,
        name: season.name,
        poster: season.poster,
        episodeCount: season.episodeCount,
      })),
      files: files.map(presentMediaFile),
      progress: progress === null ? null : presentProgress(progress),
      nextEpisode: next === null ? null : await presentEpisodeFor(ctx, profileId, next),
      inMyList: listed !== null,
    };
  },
});

export const episodes = query({
  args: { profileId: v.id("profiles"), titleId: v.id("titles"), seasonNumber: v.number() },
  returns: v.array(episode),
  handler: async (ctx, { profileId, titleId, seasonNumber }) => {
    const viewer = await authorize(ctx, "read");
    const audience = await loadAudience(ctx, viewer, profileId);
    await loadVisibleTitle(ctx, audience, titleId);

    const docs = await ctx.db
      .query("episodes")
      .withIndex("by_title_order", (q) => q.eq("titleId", titleId).eq("seasonNumber", seasonNumber))
      .collect();

    return Promise.all(
      docs.map(async (doc) =>
        presentEpisode(doc, await findProgress(ctx, profileId, titleId, doc._id)),
      ),
    );
  },
});
