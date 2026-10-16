/**
 * What Home writes about its titles, as Paper draws it: the billboard's split title (`DUNE` over
 * `PART TWO`) and facts, the pages it rotates through, and the two lines of a Continue watching
 * card. Pure, so the rules are tested apart from the screen.
 */
import type { ContinueWatchingItem, Home, TitleCard } from "@movies/contracts/models/catalog";
import { episodeCode, facts, formatRemaining } from "@movies/sdk/format";

/** Most titles the billboard pages through. */
const HERO_PAGES = 5;

/**
 * The billboard's titles: the server's featured title, then the newest arrivals that have a
 * backdrop to show, without repeats.
 */
export const heroTitles = (home: Home): ReadonlyArray<TitleCard> => {
  const newest = [...home.recentlyAddedMovies, ...home.recentlyAddedShows].filter(
    (title) => title.artwork.backdrop !== null,
  );

  // Sorts the copy `filter` made; Hermes, the iPhone app's engine, has no `toSorted`.
  newest.sort((a, b) => b.addedAt - a.addedAt);

  const candidates = home.featured === null ? newest : [home.featured, ...newest];
  // A Map keeps each title once, where it first appears.
  const unique = new Map(candidates.map((title) => [title.id, title]));

  return [...unique.values()].slice(0, HERO_PAGES);
};

/** A title split for the billboard: `Dune: Part Two` is `DUNE` over `PART TWO`. */
export interface BillboardTitle {
  readonly main: string;
  readonly subtitle: string | null;
}

/** Splits a name at its first colon or dash into a main title and a subtitle. */
export const billboardTitle = (name: string): BillboardTitle => {
  const match = /^(.+?)\s*(?::|\s[–—-])\s+(.+)$/u.exec(name);
  const main = match?.[1];
  const subtitle = match?.[2];

  return main === undefined || subtitle === undefined
    ? { main: name, subtitle: null }
    : { main, subtitle };
};

/** The billboard's fact line: `Movie · Sci-fi · 2024 · PG-13`. */
export const billboardFacts = (title: TitleCard): string =>
  facts(
    title.kind === "movie" ? "Movie" : "Show",
    title.genres[0],
    title.year,
    title.certification,
  );

/** The lines of a Continue watching card. */
export interface ContinueText {
  /** The title over the still. */
  readonly artTitle: string;
  /** `Severance · S2:E4`, or the movie's name. */
  readonly title: string;
  /** `41m left`, `Next`, or nothing. */
  readonly subtitle: string | undefined;
}

/** What a Continue watching card says. */
export const continueText = (item: ContinueWatchingItem): ContinueText => {
  const left =
    item.progress === null || item.progress.watched
      ? undefined
      : formatRemaining(item.progress.durationMs - item.progress.positionMs);

  if (item.episode === null)
    return { artTitle: item.title.name, title: item.title.name, subtitle: left };

  return {
    artTitle: item.title.name,
    title: `${item.title.name} · ${episodeCode(item.episode)}`,
    subtitle: item.reason === "next" ? "Next" : left,
  };
};
