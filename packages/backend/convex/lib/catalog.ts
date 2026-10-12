/**
 * Catalog writes from the media service's scans. Files are identified by library and path, titles
 * by library and match key, episodes by title, season, and episode number. Counters of present
 * files decide whether a title or episode is available; missing files keep their records and the
 * history that points at them.
 */
import type { Infer } from "convex/values";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { fail } from "./errors";
import type { scannedEpisode, scannedItem, scannedTitle } from "./validators";

/** Text the title search index matches: names, the year, and any override name. */
export const searchTextOf = (title: {
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

/** The fields a scan or metadata job writes onto a title. */
export const titleMetadata = (scanned: Infer<typeof scannedTitle>) => {
  const sortName = scanned.sortName ?? scanned.name;

  return {
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

const upsertTitle = async (
  ctx: MutationCtx,
  libraryId: Id<"libraries">,
  scanned: Infer<typeof scannedTitle>,
  keep: Doc<"titles"> | null,
): Promise<Doc<"titles">> => {
  // A manually matched title keeps its files and metadata across rescans.
  if (keep?.matchStatus === "manual") return keep;

  const existing = await ctx.db
    .query("titles")
    .withIndex("by_library_match", (q) =>
      q.eq("libraryId", libraryId).eq("matchKey", scanned.matchKey),
    )
    .unique();

  const now = Date.now();
  const metadata = titleMetadata(scanned);

  if (existing !== null) {
    if (existing.matchStatus === "manual") return existing;

    await ctx.db.patch(existing._id, {
      ...metadata,
      matchStatus: scanned.matchStatus,
      updatedAt: now,
      searchText: searchTextOf({ ...metadata, overrides: existing.overrides }),
    });

    return { ...existing, ...metadata, matchStatus: scanned.matchStatus };
  }

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
  const created = await ctx.db.get(titleId);

  return created ?? fail("internal", "A title vanished right after it was created");
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
    }));

  if (season !== null && (scanned.seasonName !== null || scanned.seasonPoster !== null)) {
    await ctx.db.patch(season._id, {
      name: scanned.seasonName ?? season.name,
      poster: scanned.seasonPoster ?? season.poster,
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

/** Inserts or updates one scanned file with its title and episode. */
export const upsertScannedItem = async (
  ctx: MutationCtx,
  libraryId: Id<"libraries">,
  item: Infer<typeof scannedItem>,
): Promise<{
  readonly path: string;
  readonly fileId: Id<"mediaFiles">;
  readonly titleId: Id<"titles">;
  readonly episodeId: Id<"episodes"> | null;
}> => {
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

  const fields = {
    titleId: title._id,
    episodeId,
    sizeBytes: item.file.sizeBytes,
    mtimeMs: item.file.mtimeMs,
    probe: item.file.probe,
    externalSubtitles: item.file.externalSubtitles,
    versionName: item.file.versionName,
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

    return { path: item.file.path, fileId, titleId: title._id, episodeId };
  }

  await ctx.db.patch(existingFile._id, { ...fields, missingSince: undefined });
  const moved = existingFile.titleId !== title._id || existingFile.episodeId !== episodeId;

  if (!existingFile.missing && moved) {
    await adjustPresent(ctx, existingFile.titleId, existingFile.episodeId, -1);
  }

  if (existingFile.missing || moved) await adjustPresent(ctx, title._id, episodeId, 1);

  return { path: item.file.path, fileId: existingFile._id, titleId: title._id, episodeId };
};

/** Marks a file missing. Its title and episode stay, with any history pointing at them. */
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
  await ctx.db.patch(file._id, { missing: true, missingSince: Date.now() });
  await adjustPresent(ctx, file.titleId, file.episodeId, -1);

  return true;
};
