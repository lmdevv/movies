/**
 * Browsing for one profile. Every result passes through the profile's audience: titles in
 * libraries the account cannot see, or rated above a limited profile's age, never appear and look
 * missing when asked for directly.
 */
import { v } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { query } from "./_generated/server";
import { listTitles } from "./lib/browse";
import { canSee, loadAudience, loadVisibleTitle } from "./lib/access";
import { countGenres, rankBySimilarity } from "./lib/discovery";
import { CREDIT_LIMIT, creditsOf, presentCredits } from "./lib/people";
import {
  findProgress,
  NO_EXTERNAL_IDS,
  presentEpisode,
  presentEpisodeFor,
  presentMediaFile,
  presentProgress,
  presentTitleCard,
} from "./lib/present";
import {
  genreCount,
  home as homeResult,
  page,
  pageArgs,
  seasonEpisode,
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

/** Actors a title page lists. */
const CAST_LIMIT = 20;

/** Crew members a title page lists. */
const CREW_LIMIT = 20;

/** Guest stars and crew listed per episode. */
const EPISODE_CREDIT_LIMIT = 12;

/** Titles read for genre counts. */
const GENRE_SCAN = 1000;

/** Titles of the same kind read to top up "more like this". */
const SIMILAR_SCAN = 300;

/** Crew ordered the way a title page reads: who made it first. */
const CREW_ORDER = ["creator", "director", "writer", "producer", "composer"] as const;

const NO_RATINGS = { tmdb: null, imdb: null, rottenTomatoes: null, metacritic: null };

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
    genre: v.optional(v.string()),
    yearFrom: v.optional(v.number()),
    yearTo: v.optional(v.number()),
    studio: v.optional(v.string()),
    minRating: v.optional(v.number()),
  },
  returns: page(titleCard),
  handler: async (ctx, { profileId, cursor, limit, kind, libraryId, sort, ...filter }) => {
    const viewer = await authorize(ctx, "read");
    const audience = await loadAudience(ctx, viewer, profileId);
    const numItems = Math.min(Math.max(1, Math.floor(limit ?? DEFAULT_PAGE)), MAX_PAGE);

    const result = await listTitles(
      ctx,
      audience,
      { kind, libraryId, genre: filter.genre, filter },
      sort ?? "name",
      cursor ?? null,
      numItems,
    );

    return { items: result.items.map(presentTitleCard), nextCursor: result.nextCursor };
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

    const credits = await presentCredits(ctx, await creditsOf(ctx, titleId, null, CREDIT_LIMIT));

    const crew = CREW_ORDER.flatMap((kind) => credits.filter((entry) => entry.kind === kind));

    // A title may be in several collections; the one its metadata names comes first.
    const memberships = await ctx.db
      .query("collectionItems")
      .withIndex("by_title", (q) => q.eq("titleId", titleId))
      .take(20);

    const membership = memberships.find((member) => member.source === "metadata") ?? memberships[0];

    const collection = membership === undefined ? null : await ctx.db.get(membership.collectionId);

    return {
      ...presentTitleCard(title),
      libraryId: title.libraryId,
      sortName: title.overrides?.sortName ?? title.sortName,
      overview: title.overrides?.overview ?? title.overview,
      tagline: title.tagline,
      externalIds: title.externalIds,
      matchStatus: title.matchStatus,
      originalName: title.originalName ?? null,
      releaseDate: title.releaseDate ?? null,
      status: title.status ?? null,
      originalLanguage: title.originalLanguage ?? null,
      studios: title.studios ?? [],
      countries: title.countries ?? [],
      tags: title.tags ?? [],
      ratings: title.ratings ?? NO_RATINGS,
      trailer: title.trailer ?? null,
      collection: collection === null ? null : { id: collection._id, name: collection.name },
      cast: credits.filter((entry) => entry.kind === "actor").slice(0, CAST_LIMIT),
      crew: crew.slice(0, CREW_LIMIT),
      seasons: seasons.map((season) => ({
        id: season._id,
        seasonNumber: season.seasonNumber,
        name: season.name,
        poster: season.poster,
        episodeCount: season.episodeCount,
        externalIds: season.externalIds ?? NO_EXTERNAL_IDS,
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
  returns: v.array(seasonEpisode),
  handler: async (ctx, { profileId, titleId, seasonNumber }) => {
    const viewer = await authorize(ctx, "read");
    const audience = await loadAudience(ctx, viewer, profileId);
    await loadVisibleTitle(ctx, audience, titleId);

    const docs = await ctx.db
      .query("episodes")
      .withIndex("by_title_order", (q) => q.eq("titleId", titleId).eq("seasonNumber", seasonNumber))
      .collect();

    return Promise.all(
      docs.map(async (doc) => {
        const [watch, credits] = await Promise.all([
          findProgress(ctx, profileId, titleId, doc._id),
          creditsOf(ctx, titleId, doc._id, EPISODE_CREDIT_LIMIT),
        ]);

        return Object.assign(presentEpisode(doc, watch), {
          credits: await presentCredits(ctx, credits),
        });
      }),
    );
  },
});

/** Titles of `kind` (or of every kind) to count genres over or rank as similar. */
const discoveryCandidates = async (
  ctx: QueryCtx,
  kind: Doc<"titles">["kind"] | undefined,
  count: number,
): Promise<Array<Doc<"titles">>> =>
  kind === undefined
    ? ctx.db.query("titles").withIndex("by_added").order("desc").take(count)
    : ctx.db
        .query("titles")
        .withIndex("by_kind_added", (q) => q.eq("kind", kind))
        .order("desc")
        .take(count);

/**
 * Genres the profile's titles carry, most common first. Counts cover the most recently added
 * titles of the kind, up to a thousand, so a vast library counts its newer part.
 */
export const genres = query({
  args: { profileId: v.id("profiles"), kind: v.optional(titleKind) },
  returns: v.array(genreCount),
  handler: async (ctx, { profileId, kind }) => {
    const viewer = await authorize(ctx, "read");
    const audience = await loadAudience(ctx, viewer, profileId);
    const titles = await discoveryCandidates(ctx, kind, GENRE_SCAN);

    return countGenres(titles.filter((title) => canSee(audience, title)));
  },
});

/**
 * More like this: the provider's recommendations that are in the profile's libraries, best first,
 * topped up with titles of the same kind sharing genres, keywords, and studios.
 */
export const similar = query({
  args: { profileId: v.id("profiles"), titleId: v.id("titles"), limit: v.optional(v.number()) },
  returns: v.array(titleCard),
  handler: async (ctx, { profileId, titleId, limit }) => {
    const viewer = await authorize(ctx, "read");
    const audience = await loadAudience(ctx, viewer, profileId);
    const title = await loadVisibleTitle(ctx, audience, titleId);
    const wanted = Math.min(Math.max(1, Math.floor(limit ?? ROW_LIMIT)), 50);

    const recommended = await Promise.all(
      (title.recommendations ?? []).map(async (tmdb) => {
        const matches = await ctx.db
          .query("titles")
          .withIndex("by_kind_tmdb", (q) => q.eq("kind", title.kind).eq("externalIds.tmdb", tmdb))
          .take(5);

        return matches.find((match) => match._id !== title._id && canSee(audience, match));
      }),
    );

    const chosen = recommended.flatMap((match) => (match === undefined ? [] : [match]));
    const seen = new Set([title._id, ...chosen.map((match) => match._id)]);

    const topUp =
      chosen.length >= wanted
        ? []
        : rankBySimilarity(
            title,
            (await discoveryCandidates(ctx, title.kind, SIMILAR_SCAN)).filter(
              (candidate) => !seen.has(candidate._id) && canSee(audience, candidate),
            ),
          );

    return [...chosen, ...topUp].slice(0, wanted).map(presentTitleCard);
  },
});
