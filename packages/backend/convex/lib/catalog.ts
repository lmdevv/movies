import type { Infer } from "convex/values";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { fail } from "./errors";
import { changesAny } from "./changes";
import { syncTitleGenres } from "./genres";
import { NO_EXTERNAL_IDS } from "./present";
import { forgetTrickplay, queueTrickplay } from "./trickplay";
import type {
  metadataOverrides,
  scannedEpisode,
  scannedItem,
  scannedTitle,
  upsertedFile,
} from "./validators";

const searchTextOf = (title: {
  readonly name: string;
  readonly sortName: string;
  readonly year: number | null;
  readonly overrides?: { readonly name?: string } | undefined;
}): string =>
  [
    title.overrides?.name,
    title.name,
    title.sortName === title.name ? undefined : title.sortName,
    title.year,
  ]
    .filter((part) => part !== undefined && part !== null)
    .join(" ");

/**
 * The key title lists sort by: a sort name an admin set wins over the scanned one. A name override
 * alone leaves the order as scanned, so fixing a typo in "Teh Matrix" keeps it under M.
 */
export const sortKeyOf = (title: {
  readonly sortName: string;
  readonly overrides?: { readonly sortName?: string } | undefined;
}): string => {
  const override = title.overrides?.sortName?.trim();

  return (override === undefined || override === "" ? title.sortName : override).toLowerCase();
};

/** Runs `step` for each item in order; catalog writes read the counters the previous one changed. */
export const inSequence = async <Item, Result>(
  items: ReadonlyArray<Item>,
  step: (item: Item) => Promise<Result>,
): Promise<Array<Result>> => {
  const results: Array<Result> = [];

  const run = async (index: number): Promise<void> => {
    const item = items[index];

    if (item === undefined) return;
    results.push(await step(item));
    await run(index + 1);
  };

  await run(0);

  return results;
};

const adjustPresent = async (
  ctx: MutationCtx,
  titleId: Id<"titles">,
  episodeId: Id<"episodes"> | null,
  delta: number,
): Promise<void> => {
  const title = await ctx.db.get(titleId);

  if (title !== null) {
    await ctx.db.patch(titleId, { presentFileCount: Math.max(0, title.presentFileCount + delta) });
  }

  if (episodeId === null) return;
  const episode = await ctx.db.get(episodeId);

  if (episode !== null) {
    await ctx.db.patch(episodeId, {
      presentFileCount: Math.max(0, episode.presentFileCount + delta),
    });
  }
};

/** The shape of a YouTube video ID; `YOUTUBE_KEY_PATTERN` in contracts. */
export const YOUTUBE_KEY = /^[\w-]{6,20}$/u;

const checkedTrailer = (trailer: Infer<typeof scannedTitle>["trailer"]) =>
  trailer === undefined || trailer === null || YOUTUBE_KEY.test(trailer.key) ? trailer : null;

type RichMetadata = Partial<
  Pick<
    Doc<"titles">,
    | "originalName"
    | "releaseDate"
    | "status"
    | "originalLanguage"
    | "studios"
    | "countries"
    | "tags"
    | "ratings"
    | "trailer"
    | "recommendations"
  >
>;

const richMetadata = (scanned: Infer<typeof scannedTitle>): RichMetadata => {
  const rich: RichMetadata = {};
  const trailer = checkedTrailer(scanned.trailer);

  if (scanned.originalName !== undefined) rich.originalName = scanned.originalName;

  if (scanned.releaseDate !== undefined) rich.releaseDate = scanned.releaseDate;

  if (scanned.status !== undefined) rich.status = scanned.status;

  if (scanned.originalLanguage !== undefined) rich.originalLanguage = scanned.originalLanguage;

  if (scanned.studios !== undefined) rich.studios = scanned.studios.slice(0, TITLE_LIST_LIMIT);

  if (scanned.countries !== undefined) {
    rich.countries = scanned.countries.slice(0, TITLE_LIST_LIMIT);
  }

  if (scanned.tags !== undefined) rich.tags = scanned.tags.slice(0, TITLE_TAG_LIMIT);

  if (scanned.ratings !== undefined) rich.ratings = scanned.ratings;

  if (trailer !== undefined) rich.trailer = trailer;

  if (scanned.recommendations !== undefined) {
    rich.recommendations = scanned.recommendations.slice(0, TITLE_LIST_LIMIT);
  }

  return rich;
};

/** Most studios, countries, or recommendations a title keeps; `TITLE_LIST_LIMIT` in contracts. */
export const TITLE_LIST_LIMIT = 20;

/** Most keywords a title keeps; `TITLE_TAG_LIMIT` in contracts. */
export const TITLE_TAG_LIMIT = 40;

const titleMetadata = (scanned: Infer<typeof scannedTitle>) => {
  const sortName = scanned.sortName ?? scanned.name;

  return {
    ...richMetadata(scanned),
    kind: scanned.kind,
    name: scanned.name,
    sortName,
    sortKey: sortName.toLowerCase(),
    year: scanned.year,
    overview: scanned.overview,
    tagline: scanned.tagline,
    genres: scanned.genres,
    certification: scanned.certification,
    ageRating: scanned.ageRating,
    runtimeMs: scanned.runtimeMs,
    artwork: scanned.artwork,
    externalIds: scanned.externalIds,
  };
};

const keepKnown = (
  scanned: Infer<typeof scannedTitle>,
  existing: Doc<"titles">,
): Infer<typeof scannedTitle> => {
  const externalIds = {
    tmdb: scanned.externalIds.tmdb ?? existing.externalIds.tmdb,
    imdb: scanned.externalIds.imdb ?? existing.externalIds.imdb,
    tvdb: scanned.externalIds.tvdb ?? existing.externalIds.tvdb,
  };

  const identified = Object.values(externalIds).some((id) => id !== null);
  const stored = existing.ratings;

  const ratings =
    scanned.ratings === undefined || stored === undefined
      ? scanned.ratings
      : {
          tmdb: scanned.ratings.tmdb ?? stored.tmdb,
          imdb: scanned.ratings.imdb ?? stored.imdb,
          rottenTomatoes: scanned.ratings.rottenTomatoes ?? stored.rottenTomatoes,
          metacritic: scanned.ratings.metacritic ?? stored.metacritic,
        };

  const kept = {
    ...scanned,
    externalIds,
    matchStatus:
      identified && existing.matchStatus !== "unmatched" ? "matched" : scanned.matchStatus,
  } satisfies Infer<typeof scannedTitle>;

  if (ratings !== undefined) kept.ratings = ratings;

  return kept;
};

/**
 * What a scan or metadata job writes onto a stored title: the scanned fields with the IDs and
 * scores it keeps, sorted and searched under the overrides an admin made.
 */
export const rescannedTitle = (scanned: Infer<typeof scannedTitle>, existing: Doc<"titles">) => {
  const merged = keepKnown(scanned, existing);
  const metadata = titleMetadata(merged);
  const named = { ...metadata, overrides: existing.overrides };

  return {
    ...metadata,
    matchStatus: merged.matchStatus,
    sortKey: sortKeyOf(named),
    searchText: searchTextOf(named),
  };
};

const upsertTitle = async (
  ctx: MutationCtx,
  libraryId: Id<"libraries">,
  scanned: Infer<typeof scannedTitle>,
  keep: Doc<"titles"> | null,
): Promise<Doc<"titles">> => {
  if (keep?.matchStatus === "manual") return keep;

  const existing =
    keep?.libraryId === libraryId && keep.matchKey === scanned.matchKey
      ? keep
      : await ctx.db
          .query("titles")
          .withIndex("by_library_match", (q) =>
            q.eq("libraryId", libraryId).eq("matchKey", scanned.matchKey),
          )
          .unique();

  const now = Date.now();

  if (existing !== null) {
    if (existing.matchStatus === "manual") return existing;
    const fields = rescannedTitle(scanned, existing);

    if (!changesAny(existing, fields)) return existing;

    await ctx.db.patch(existing._id, { ...fields, updatedAt: now });

    const updated = { ...existing, ...fields };

    await syncTitleGenres(ctx, updated);

    return updated;
  }

  const metadata = titleMetadata(scanned);

  const titleId = await ctx.db.insert("titles", {
    libraryId,
    matchKey: scanned.matchKey,
    ...metadata,
    matchStatus: scanned.matchStatus,
    presentFileCount: 0,
    addedAt: now,
    updatedAt: now,
    searchText: searchTextOf(metadata),
  });

  const library = await ctx.db.get(libraryId);

  if (library !== null) await ctx.db.patch(libraryId, { titleCount: library.titleCount + 1 });

  const created =
    (await ctx.db.get(titleId)) ?? fail("internal", "A title vanished right after it was created");

  await syncTitleGenres(ctx, created);

  return created;
};

/**
 * Stores the overrides an admin or a migration set on a title, and sorts and indexes it under them.
 */
export const writeOverrides = async (
  ctx: MutationCtx,
  title: Doc<"titles">,
  overrides: Infer<typeof metadataOverrides>,
): Promise<void> => {
  const named = { ...title, overrides };
  const sortKey = sortKeyOf(named);

  await ctx.db.patch(title._id, {
    overrides,
    sortKey,
    searchText: searchTextOf(named),
    updatedAt: Date.now(),
  });

  if (sortKey !== title.sortKey) await syncTitleGenres(ctx, { ...named, sortKey });
};

/** Finds or creates a show's season and episode, updating their names and artwork. */
export const upsertEpisode = async (
  ctx: MutationCtx,
  titleId: Id<"titles">,
  scanned: Infer<typeof scannedEpisode>,
): Promise<Doc<"episodes">> => {
  const season = await ctx.db
    .query("seasons")
    .withIndex("by_title_number", (q) =>
      q.eq("titleId", titleId).eq("seasonNumber", scanned.seasonNumber),
    )
    .unique();

  const seasonName =
    scanned.seasonName ??
    (scanned.seasonNumber === 0 ? "Specials" : `Season ${scanned.seasonNumber}`);

  const seasonId =
    season?._id ??
    (await ctx.db.insert("seasons", {
      titleId,
      seasonNumber: scanned.seasonNumber,
      name: seasonName,
      poster: scanned.seasonPoster,
      episodeCount: 0,
      externalIds: scanned.seasonExternalIds ?? NO_EXTERNAL_IDS,
    }));

  if (
    season !== null &&
    (scanned.seasonName !== null ||
      scanned.seasonPoster !== null ||
      scanned.seasonExternalIds !== undefined)
  ) {
    await ctx.db.patch(season._id, {
      name: scanned.seasonName ?? season.name,
      poster: scanned.seasonPoster ?? season.poster,
      externalIds: scanned.seasonExternalIds ?? season.externalIds,
    });
  }

  const existing = await ctx.db
    .query("episodes")
    .withIndex("by_title_order", (q) =>
      q
        .eq("titleId", titleId)
        .eq("seasonNumber", scanned.seasonNumber)
        .eq("episodeNumber", scanned.episodeNumber),
    )
    .unique();

  const fields = {
    name: scanned.name ?? existing?.name ?? `Episode ${scanned.episodeNumber}`,
    overview: scanned.overview ?? existing?.overview ?? null,
    airDate: scanned.airDate ?? existing?.airDate ?? null,
    runtimeMs: scanned.runtimeMs ?? existing?.runtimeMs ?? null,
    still: scanned.still ?? existing?.still ?? null,
    rating: scanned.rating ?? existing?.rating ?? null,
    externalIds: scanned.externalIds ?? existing?.externalIds ?? NO_EXTERNAL_IDS,
  };

  if (existing !== null) {
    await ctx.db.patch(existing._id, fields);

    return { ...existing, ...fields };
  }

  const episodeId = await ctx.db.insert("episodes", {
    titleId,
    seasonId,
    seasonNumber: scanned.seasonNumber,
    episodeNumber: scanned.episodeNumber,
    ...fields,
    presentFileCount: 0,
  });

  const seasonDoc = await ctx.db.get(seasonId);

  if (seasonDoc !== null)
    await ctx.db.patch(seasonId, { episodeCount: seasonDoc.episodeCount + 1 });
  const created = await ctx.db.get(episodeId);

  return created ?? fail("internal", "An episode vanished right after it was created");
};

/**
 * Inserts or updates one scanned file with its title and episode, and queues scrub thumbnails for
 * it when the library makes them and the file is new or changed.
 */
export const upsertScannedItem = async (
  ctx: MutationCtx,
  library: Doc<"libraries">,
  item: Infer<typeof scannedItem>,
): Promise<Infer<typeof upsertedFile>> => {
  const libraryId = library._id;

  const existingFile = await ctx.db
    .query("mediaFiles")
    .withIndex("by_library_path", (q) => q.eq("libraryId", libraryId).eq("path", item.file.path))
    .unique();

  const previousTitle = existingFile === null ? null : await ctx.db.get(existingFile.titleId);
  const title = await upsertTitle(ctx, libraryId, item.title, previousTitle);

  const episode =
    title.kind === "show" && item.episode !== null
      ? await upsertEpisode(ctx, title._id, item.episode)
      : null;

  const episodeId = episode?._id ?? null;

  const landed = {
    titleId: title._id,
    episodeId,
    titleCreditsHash: title.creditsHash ?? null,
    episodeCreditsHash: episode?.creditsHash ?? null,
    collectionHash: title.collectionHash ?? null,
  };

  const fields = {
    titleId: title._id,
    episodeId,
    sizeBytes: item.file.sizeBytes,
    mtimeMs: item.file.mtimeMs,
    probe: item.file.probe,
    externalSubtitles: item.file.externalSubtitles,
    versionName: item.file.versionName,
    sidecarDigest: item.file.sidecarDigest ?? null,
    hdr: (item.file.probe.video[0]?.hdr ?? "none") !== "none",
    missing: false,
  };

  if (existingFile === null) {
    const fileId = await ctx.db.insert("mediaFiles", {
      libraryId,
      path: item.file.path,
      ...fields,
      addedAt: Date.now(),
    });

    await adjustPresent(ctx, title._id, episodeId, 1);

    if (library.trickplay !== false) {
      await queueTrickplayFor(ctx, library, await ctx.db.get(fileId));
    }

    return { path: item.file.path, fileId, ...landed };
  }

  const { missingSince: _wasMissingSince, ...stillThere } = existingFile;

  await ctx.db.patch(existingFile._id, { ...fields, missingSince: undefined });
  await queueTrickplayFor(ctx, library, { ...stillThere, ...fields });
  const moved = existingFile.titleId !== title._id || existingFile.episodeId !== episodeId;

  if (!existingFile.missing && moved) {
    await adjustPresent(ctx, existingFile.titleId, existingFile.episodeId, -1);
  }

  if (existingFile.missing || moved) await adjustPresent(ctx, title._id, episodeId, 1);

  return { path: item.file.path, fileId: existingFile._id, ...landed };
};

const queueTrickplayFor = async (
  ctx: MutationCtx,
  library: Doc<"libraries">,
  file: Doc<"mediaFiles"> | null,
): Promise<void> => {
  if (file !== null && library.trickplay !== false) {
    await queueTrickplay(ctx, file, { retryFailed: false, requestedBy: null });
  }
};

/**
 * Marks a file missing. Its title and episode stay, with any history pointing at them; its scrub
 * thumbnails are forgotten (the media service deletes them), so a file that returns gets new ones.
 */
export const markFileMissing = async (
  ctx: MutationCtx,
  libraryId: Id<"libraries">,
  path: string,
): Promise<boolean> => {
  const file = await ctx.db
    .query("mediaFiles")
    .withIndex("by_library_path", (q) => q.eq("libraryId", libraryId).eq("path", path))
    .unique();

  if (file === null || file.missing) return false;
  await forgetTrickplay(ctx, file);
  await ctx.db.patch(file._id, { missing: true, missingSince: Date.now() });
  await adjustPresent(ctx, file.titleId, file.episodeId, -1);

  return true;
};
