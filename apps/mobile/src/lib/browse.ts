/**
 * What the browse screens (Home, Movies, Shows, My List, Search, collections, genres, people) show,
 * worked out from the server's rows: the hero pages, their facts and play action, which layout
 * Home takes while libraries scan, the grid's filters as `titles.list` arguments, and counts.
 */
import type { CommandArgs } from "@movies/contracts/commands";
import type { LibraryId, ProfileId, TitleId } from "@movies/contracts/ids";
import type {
  HistoryEntry,
  Home,
  Library,
  TitleCard,
  TitleDetail,
  TitleKind,
  TitleSort,
} from "@movies/contracts/models/catalog";

import { episodeCode, facts, formatRuntime, progressFraction } from "./format";
import { watchHref } from "./routes";

/** `1 movie`, `8 movies`. */
export const plural = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`;

/** Most pages the hero pages through on Home, Movies, and Shows. */
const HERO_PAGES = 5;

/**
 * The titles the hero pages through: the server's featured title first, then the newest arrivals
 * that have wide artwork to fill the hero, without repeats.
 */
export const heroTitles = (
  featured: TitleCard | null,
  candidates: ReadonlyArray<TitleCard>,
): ReadonlyArray<TitleCard> => {
  const pages = featured === null ? [] : [featured];

  for (const title of candidates) {
    if (pages.length >= HERO_PAGES) break;

    if (title.artwork.backdrop !== null && pages.every((page) => page.id !== title.id)) {
      pages.push(title);
    }
  }

  return pages;
};

/**
 * Home's arrivals across both kinds, newest first: merges the movie and show rows, which each
 * arrive newest first. (Hermes has no `toSorted`, and merging keeps the server's order.)
 */
export const newestFirst = (
  movies: ReadonlyArray<TitleCard>,
  shows: ReadonlyArray<TitleCard>,
): ReadonlyArray<TitleCard> => {
  const merged: Array<TitleCard> = [];
  let movie = 0;
  let show = 0;

  while (movie < movies.length || show < shows.length) {
    const nextMovie = movies[movie];
    const nextShow = shows[show];

    if (
      nextShow === undefined ||
      (nextMovie !== undefined && nextMovie.addedAt >= nextShow.addedAt)
    ) {
      if (nextMovie !== undefined) merged.push(nextMovie);

      movie += 1;
    } else {
      merged.push(nextShow);
      show += 1;
    }
  }

  return merged;
};

/**
 * The hero's line under the title, as C01 writes it: `Thriller · 2 seasons · TV-MA`, or the
 * running time for movies. A show's season count arrives with its details.
 */
export const heroFacts = (title: TitleCard, seasonCount: number | null): string =>
  facts(
    title.genres[0],
    title.kind === "show"
      ? seasonCount === null || seasonCount === 0
        ? title.year
        : plural(seasonCount, "season", "seasons")
      : title.runtimeMs === null
        ? title.year
        : formatRuntime(title.runtimeMs),
    title.certification,
  );

/** What a title's Play button says and where it goes. */
export interface PlayTarget {
  /** `Play`, `Resume`, `Play S1:E1`, or `Resume S2:E3`. */
  readonly label: string;
  readonly href: string;
}

/**
 * The play action for a title once its details load: resume a started movie, or resume or start
 * the show's next episode. Before the details arrive it plays the title from where the player
 * decides.
 */
export const playTarget = (
  titleId: TitleId,
  detail: Pick<TitleDetail, "kind" | "progress" | "nextEpisode"> | null,
): PlayTarget => {
  if (detail === null) return { label: "Play", href: watchHref({ titleId }) };

  if (detail.kind === "movie") {
    const started =
      detail.progress !== null &&
      !detail.progress.watched &&
      progressFraction(detail.progress) !== null;

    return { label: started ? "Resume" : "Play", href: watchHref({ titleId }) };
  }

  const next = detail.nextEpisode;

  if (next === null) return { label: "Play", href: watchHref({ titleId }) };

  const started = next.progress !== null && !next.progress.watched && next.progress.positionMs > 0;

  return {
    label: `${started ? "Resume" : "Play"} ${episodeCode(next)}`,
    href: watchHref({ titleId, episodeId: next.id }),
  };
};

/** While a scan runs, Home keeps the scanning layout until this many titles have arrived. */
const SCANNING_UNTIL = 8;

/** Which Home the profile sees. */
export type HomeLayout =
  /** No library at all yet (C12). */
  | "empty"
  /** A library scans and few titles have arrived (C13). */
  | "scanning"
  /** Libraries exist but nothing in them is visible to this profile. */
  | "nothing"
  /** The hero and rows (C01). */
  | "rows";

/** Home's layout for these rows and libraries. */
export const homeLayout = (home: Home, libraries: ReadonlyArray<Library>): HomeLayout => {
  if (libraries.length === 0) return "empty";

  const arrived = home.recentlyAddedMovies.length + home.recentlyAddedShows.length;

  if (
    libraries.some((library) => library.scanning) &&
    (home.featured === null || arrived < SCANNING_UNTIL)
  ) {
    return "scanning";
  }

  if (home.featured === null && arrived === 0 && home.myList.length === 0) return "nothing";

  return "rows";
};

/** The libraries that hold titles of `kind`: their own kind, or mixed. */
export const librariesFor = (
  libraries: ReadonlyArray<Library>,
  kind: TitleKind,
): ReadonlyArray<Library> =>
  libraries.filter(
    (library) =>
      library.kind === "mixed" || library.kind === (kind === "movie" ? "movies" : "shows"),
  );

/** How the Movies and Shows grids are ordered and narrowed. */
export interface BrowseFilters {
  readonly sort: TitleSort;
  readonly genre: string | null;
  readonly libraryId: LibraryId | null;
}

/** Newest arrivals first, every genre, every library. */
export const DEFAULT_FILTERS: BrowseFilters = { sort: "added", genre: null, libraryId: null };

/** Sort orders the server offers, as C14 names them, in the sheet's order. */
export const SORT_OPTIONS: ReadonlyArray<{ readonly sort: TitleSort; readonly label: string }> = [
  { sort: "added", label: "Recently Added" },
  { sort: "name", label: "Title" },
  { sort: "year", label: "Release Date" },
];

/** Whether a genre or library hides some titles. */
export const isNarrowed = (filters: BrowseFilters): boolean =>
  filters.genre !== null || filters.libraryId !== null;

type Mutable<Value> = { -readonly [Key in keyof Value]: Value[Key] };

/** The `titles.list` arguments for one page of a grid. */
export const listArgs = (
  profileId: ProfileId,
  kind: TitleKind | null,
  filters: BrowseFilters,
  cursor: string | null,
  limit: number,
): CommandArgs<"titles.list"> => {
  const args: Mutable<CommandArgs<"titles.list">> = {
    profileId,
    sort: filters.sort,
    cursor,
    limit,
  };

  if (kind !== null) args.kind = kind;

  if (filters.genre !== null) args.genre = filters.genre;

  if (filters.libraryId !== null) args.libraryId = filters.libraryId;

  return args;
};

/** `Movies` or `Shows`, or `Titles` for both kinds. */
export const kindLabel = (kind: TitleKind | null): string => {
  if (kind === null) return "Titles";

  return kind === "movie" ? "Movies" : "Shows";
};

/** `8 movies`, `12 shows`, or `5 titles` when a collection holds both kinds. */
export const titleCount = (titles: ReadonlyArray<Pick<TitleCard, "kind">>): string => {
  const kinds = new Set(titles.map((title) => title.kind));

  if (kinds.size === 1 && kinds.has("movie")) return plural(titles.length, "movie", "movies");

  if (kinds.size === 1 && kinds.has("show")) return plural(titles.length, "show", "shows");

  return plural(titles.length, "title", "titles");
};

/** `Movie · 2024` or `Show · 2019`: a title's kind and year in search rows. */
export const kindFacts = (title: Pick<TitleCard, "kind" | "year">): string =>
  facts(title.kind === "movie" ? "Movie" : "Show", title.year);

/** Where a profile stands on a title, as far as its history tells. */
export type WatchState = "watched" | "started";

/**
 * Each title's watch state from history. A movie is watched when its entry says so. A show is
 * watched when every episode in its history is (as after Mark as Watched, which marks them all),
 * and started otherwise; history cannot tell an episode never played, so a show whose played
 * episodes are all finished counts as watched. Titles without history are absent.
 */
export const watchStates = (
  entries: ReadonlyArray<Pick<HistoryEntry, "title" | "episode" | "progress">>,
): ReadonlyMap<TitleId, WatchState> => {
  const states = new Map<TitleId, WatchState>();

  for (const entry of entries) {
    const state = entry.progress.watched ? "watched" : "started";

    // One unfinished episode makes the whole show started.
    if (entry.episode === null || states.get(entry.title.id) !== "started") {
      states.set(entry.title.id, state);
    }
  }

  return states;
};

/** Which kinds a list shows: both, or one. */
export type KindFilter = "all" | TitleKind;

/** The All, Movies, and Shows chips of My List, Search, and genre pages. */
export const KIND_FILTERS: ReadonlyArray<{ readonly kind: KindFilter; readonly label: string }> = [
  { kind: "all", label: "All" },
  { kind: "movie", label: "Movies" },
  { kind: "show", label: "Shows" },
];

/** The titles of `kind`, or all of them. */
export const ofKind = (
  titles: ReadonlyArray<TitleCard>,
  kind: KindFilter,
): ReadonlyArray<TitleCard> =>
  kind === "all" ? titles : titles.filter((title) => title.kind === kind);

/** Posters per row in the browse grids. */
const GRID_COLUMNS = 3;

/** A grid cell: a title, or a blank that keeps the last row's posters at a third of the width. */
export type GridCell =
  | { readonly kind: "title"; readonly title: TitleCard }
  | { readonly kind: "blank"; readonly key: string };

/** The cells of a three-column grid of `titles`, padded with blanks to whole rows. */
export const gridCells = (titles: ReadonlyArray<TitleCard>): ReadonlyArray<GridCell> => {
  const blanks = (GRID_COLUMNS - (titles.length % GRID_COLUMNS)) % GRID_COLUMNS;

  return [
    ...titles.map((title): GridCell => ({ kind: "title", title })),
    ...Array.from({ length: blanks }, (_, index): GridCell => ({
      kind: "blank",
      key: `blank-${index}`,
    })),
  ];
};

/** The titles a person is credited on, once each, in the order the server lists them. */
export const creditedTitles = (
  credits: ReadonlyArray<{ readonly title: TitleCard }>,
): ReadonlyArray<TitleCard> => {
  const seen = new Set<TitleId>();

  return credits.flatMap((credit) => {
    if (seen.has(credit.title.id)) return [];

    seen.add(credit.title.id);

    return [credit.title];
  });
};
