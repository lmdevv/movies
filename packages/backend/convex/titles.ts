import { v } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { query } from "./_generated/server";
import { resultLimit } from "./lib/bounds";
import { listTitles } from "./lib/browse";
import type { Audience } from "./lib/access";
import { canSee, loadAudience, loadVisibleTitle } from "./lib/access";
import { countGenres, rankBySimilarity } from "./lib/discovery";
import { CREDIT_LIMIT, creditsOf, presentCreditGroups } from "./lib/people";
import { filesOnDisk, onDiskBestFirst, resolveEpisode } from "./lib/playable";
import {
  findProgress,
  NO_EXTERNAL_IDS,
  presentEpisode,
  presentEpisodeFor,
  presentMediaFile,
  presentProgress,
  presentTitleCard,
  presentVersion,
} from "./lib/present";
import {
  genreCount,
  home as homeResult,
  mediaVersion,
  page,
  pageArgs,
  seasonEpisode,
  titleCard,
  titleDetail,
  titleKind,
  titleSort,
} from "./lib/validators";
import { continueWatching, firstVisible, itself, upNextEpisode } from "./lib/viewing";
import { authorize } from "./lib/viewer";

const ROW_SCAN = 200;

const ROW_LIMIT = 20;

const DEFAULT_PAGE = 50;

const MAX_PAGE = 100;

const CAST_LIMIT = 20;

const CREW_LIMIT = 20;

const EPISODE_CREDIT_LIMIT = 12;

const GENRE_SCAN = 1000;

const SIMILAR_SCAN = 300;

const CREW_ORDER = ["creator", "director", "writer", "producer", "composer"] as const;

const NO_RATINGS = { tmdb: null, imdb: null, rottenTomatoes: null, metacritic: null };

/**
 * The home screen for a profile: a featured title, continue watching, My List, and the newest
 * movies and shows, up to 20 per row of what the profile may see.
 */
export const home = query({
  args: { profileId: v.id("profiles") },
  returns: homeResult,
  handler: async (ctx, { profileId }) => {
    const viewer = await authorize(ctx, "read");
    const audience = await loadAudience(ctx, viewer, profileId);

    const row = { limit: ROW_LIMIT, scanLimit: ROW_SCAN };

    const recent = (kind: Doc<"titles">["kind"]) =>
      firstVisible(
        audience,
        ctx.db
          .query("titles")
          .withIndex("by_kind_added", (q) => q.eq("kind", kind))
          .order("desc"),
        itself,
        row,
      );

    const listed = firstVisible(
      audience,
      ctx.db
        .query("myList")
        .withIndex("by_profile_added", (q) => q.eq("profileId", profileId))
        .order("desc"),
      (entry) => ctx.db.get(entry.titleId),
      row,
    );

    const [movies, shows, myList] = await Promise.all([recent("movie"), recent("show"), listed]);

    const featured = [...movies, ...shows]
      .filter((title) => title.artwork.backdrop !== null && title.presentFileCount > 0)
      .toSorted((left, right) => right.addedAt - left.addedAt)[0];

    return {
      featured: featured === undefined ? null : presentTitleCard(featured),
      continueWatching: await continueWatching(ctx, audience),
      myList: myList.map(presentTitleCard),
      recentlyAddedMovies: movies.map(presentTitleCard),
      recentlyAddedShows: shows.map(presentTitleCard),
    };
  },
});

/**
 * One page of the titles the profile may see, by name unless `sort` says otherwise, narrowed by
 * kind, library, genre, years, studio, and rating. A page can come back short while `nextCursor`
 * continues it.
 */
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
    const numItems = resultLimit(limit, DEFAULT_PAGE, MAX_PAGE);

    const result = await listTitles(
      ctx,
      audience,
      { kind, libraryId, filter },
      sort ?? "name",
      cursor ?? null,
      numItems,
    );

    return { items: result.items.map(presentTitleCard), nextCursor: result.nextCursor };
  },
});

/**
 * Titles matching `query` that the profile may see, best match first. Among the first 200 hits
 * only, so hidden titles can leave fewer results than the limit; a blank query returns none.
 */
export const search = query({
  args: { profileId: v.id("profiles"), query: v.string(), limit: v.optional(v.number()) },
  returns: v.array(titleCard),
  handler: async (ctx, { profileId, query: text, limit }) => {
    const viewer = await authorize(ctx, "read");
    const audience = await loadAudience(ctx, viewer, profileId);
    const wanted = resultLimit(limit, 20, 50);

    if (text.trim().length === 0) return [];

    const matches = await firstVisible(
      audience,
      ctx.db
        .query("titles")
        .withSearchIndex("search_text", (q) => q.search("searchText", text.trim())),
      itself,
      { limit: wanted, scanLimit: ROW_SCAN },
    );

    return matches.map(presentTitleCard);
  },
});

/**
 * A title page for a profile: details with overrides applied, cast and crew, seasons, a movie's
 * files and progress, a show's next episode, and whether it is on My List. A title the profile may
 * not see fails with `not_found`.
 */
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

    const rows = await creditsOf(ctx, titleId, null, CREDIT_LIMIT);
    const castRows = rows.filter((row) => row.kind === "actor").slice(0, CAST_LIMIT);

    const crewRows = CREW_ORDER.flatMap((kind) => rows.filter((row) => row.kind === kind)).slice(
      0,
      CREW_LIMIT,
    );

    const [cast = [], crew = []] = await presentCreditGroups(ctx, [castRows, crewRows]);

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
      cast,
      crew,
      seasons: seasons.map((season) => ({
        id: season._id,
        seasonNumber: season.seasonNumber,
        name: season.name,
        poster: season.poster,
        episodeCount: season.episodeCount,
        externalIds: season.externalIds ?? NO_EXTERNAL_IDS,
      })),
      files: files.map(presentMediaFile),
      versions: onDiskBestFirst(files, null).map((file) =>
        presentVersion(file, progress?.fileId ?? null),
      ),
      progress: progress === null ? null : presentProgress(progress),
      nextEpisode: next === null ? null : await presentEpisodeFor(ctx, profileId, next),
      inMyList: listed !== null,
    };
  },
});

/**
 * The versions of a movie, or of an episode with `episodeId`, that are on disk: best quality first,
 * with the one the profile last played marked. Shows need an episode.
 */
export const versions = query({
  args: {
    profileId: v.id("profiles"),
    titleId: v.id("titles"),
    episodeId: v.optional(v.id("episodes")),
  },
  returns: v.array(mediaVersion),
  handler: async (ctx, { profileId, titleId, episodeId }) => {
    const viewer = await authorize(ctx, "read");
    const audience = await loadAudience(ctx, viewer, profileId);
    const title = await loadVisibleTitle(ctx, audience, titleId);
    const episode = await resolveEpisode(ctx, title, episodeId ?? null);

    const [files, progress] = await Promise.all([
      filesOnDisk(ctx, title, episode),
      findProgress(ctx, profileId, titleId, episode?._id ?? null),
    ]);

    return files.map((file) => presentVersion(file, progress?.fileId ?? null));
  },
});

/** One season's episodes in order, each with the profile's progress and up to 12 credits. */
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

    const [watches, rows] = await Promise.all([
      Promise.all(docs.map((doc) => findProgress(ctx, profileId, titleId, doc._id))),
      Promise.all(docs.map((doc) => creditsOf(ctx, titleId, doc._id, EPISODE_CREDIT_LIMIT))),
    ]);

    const credits = await presentCreditGroups(ctx, rows);

    return docs.map((doc, index) =>
      Object.assign(presentEpisode(doc, watches[index] ?? null), {
        credits: credits[index] ?? [],
      }),
    );
  },
});

const discoveryCandidates = async (
  ctx: QueryCtx,
  audience: Audience,
  kind: Doc<"titles">["kind"] | undefined,
  count: number,
): Promise<Array<Doc<"titles">>> => {
  const libraries = [...audience.libraryIds];
  const share = Math.max(10, Math.ceil(count / Math.max(1, libraries.length)));

  const read = await Promise.all(
    libraries.map((libraryId) =>
      ctx.db
        .query("titles")
        .withIndex("by_library_added", (q) => q.eq("libraryId", libraryId))
        .order("desc")
        .take(share),
    ),
  );

  return read
    .flat()
    .filter((title) => (kind === undefined || title.kind === kind) && canSee(audience, title));
};

/**
 * Genres the profile's titles carry, most common first. Counts cover the most recently added
 * titles of each library the profile sees, about a thousand in all, so a vast library counts its
 * newer part.
 */
export const genres = query({
  args: { profileId: v.id("profiles"), kind: v.optional(titleKind) },
  returns: v.array(genreCount),
  handler: async (ctx, { profileId, kind }) => {
    const viewer = await authorize(ctx, "read");
    const audience = await loadAudience(ctx, viewer, profileId);

    return countGenres(await discoveryCandidates(ctx, audience, kind, GENRE_SCAN));
  },
});

const identityOf = (title: Doc<"titles">): ReadonlyArray<string> =>
  title.externalIds.tmdb === null ? [title._id] : [title._id, `tmdb:${title.externalIds.tmdb}`];

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
    const wanted = resultLimit(limit, ROW_LIMIT, 50);

    const recommended = await Promise.all(
      (title.recommendations ?? []).map(async (tmdb) => {
        const matches = await ctx.db
          .query("titles")
          .withIndex("by_kind_tmdb", (q) => q.eq("kind", title.kind).eq("externalIds.tmdb", tmdb))
          .take(5);

        return matches.find((match) => match._id !== title._id && canSee(audience, match));
      }),
    );

    const seen = new Set<string>(identityOf(title));

    const fresh = (candidate: Doc<"titles">): boolean => {
      const keys = identityOf(candidate);

      if (keys.some((key) => seen.has(key))) return false;

      for (const key of keys) seen.add(key);

      return true;
    };

    const chosen = recommended.flatMap((match) =>
      match === undefined || !fresh(match) ? [] : [match],
    );

    const topUp =
      chosen.length >= wanted
        ? []
        : rankBySimilarity(
            title,
            await discoveryCandidates(ctx, audience, title.kind, SIMILAR_SCAN),
          ).filter(fresh);

    return [...chosen, ...topUp].slice(0, wanted).map(presentTitleCard);
  },
});
