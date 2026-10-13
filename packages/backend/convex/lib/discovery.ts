/**
 * Browsing by metadata: title filters, genre counts, and "more like this". Everything here works
 * on titles the caller already loaded; the audience check stays with the caller.
 */
import type { Doc } from "../_generated/dataModel";
import { genreKey } from "./genres";

/** What `titles.list` may filter by. */
export interface TitleFilter {
  readonly genre?: string | undefined;
  readonly yearFrom?: number | undefined;
  readonly yearTo?: number | undefined;
  readonly studio?: string | undefined;
  readonly minRating?: number | undefined;
}

const folded = (text: string): string => text.trim().toLowerCase();

/** The score the rating filter and sorting use: IMDb when known, else TMDB. */
export const communityScore = (title: Doc<"titles">): number | null =>
  title.ratings?.imdb?.value ?? title.ratings?.tmdb?.value ?? null;

/** The year a title shows, after admin overrides. */
const yearOf = (title: Doc<"titles">): number | null => title.overrides?.year ?? title.year;

/** Whether any filter is set. */
export const isFiltered = (filter: TitleFilter): boolean =>
  Object.values(filter).some((value) => value !== undefined);

/** Whether a title passes every filter that is set. */
export const matchesFilter = (filter: TitleFilter, title: Doc<"titles">): boolean => {
  const { genre, studio } = filter;
  const year = yearOf(title);
  const score = communityScore(title);

  return (
    (genre === undefined || title.genres.some((name) => genreKey(name) === genreKey(genre))) &&
    (studio === undefined ||
      (title.studios ?? []).some((name) => folded(name) === folded(studio))) &&
    (filter.yearFrom === undefined || (year !== null && year >= filter.yearFrom)) &&
    (filter.yearTo === undefined || (year !== null && year <= filter.yearTo)) &&
    (filter.minRating === undefined || (score !== null && score >= filter.minRating))
  );
};

/** Genres across `titles` with their counts, most common first, then by name. */
export const countGenres = (
  titles: ReadonlyArray<Doc<"titles">>,
): Array<{ readonly name: string; readonly count: number }> => {
  const counts = new Map<string, { name: string; count: number }>();

  for (const name of titles.flatMap((title) => title.genres)) {
    const key = genreKey(name);
    const entry = counts.get(key);

    if (entry === undefined) counts.set(key, { name, count: 1 });
    else entry.count += 1;
  }

  return [...counts.values()].toSorted(
    (left, right) => right.count - left.count || left.name.localeCompare(right.name),
  );
};

const overlap = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): number => {
  const wanted = new Set(left.map(folded));

  return right.filter((value) => wanted.has(folded(value))).length;
};

/**
 * How alike two titles are by metadata alone: shared genres count twice, shared keywords and
 * studios once. Zero means nothing in common.
 */
export const similarity = (title: Doc<"titles">, candidate: Doc<"titles">): number =>
  2 * overlap(title.genres, candidate.genres) +
  overlap(title.tags ?? [], candidate.tags ?? []) +
  overlap(title.studios ?? [], candidate.studios ?? []);

/**
 * Candidates ranked by `similarity` to `title`, best first; ties go to the closer year, then the
 * better score. Titles with nothing in common are left out.
 */
export const rankBySimilarity = (
  title: Doc<"titles">,
  candidates: ReadonlyArray<Doc<"titles">>,
): Array<Doc<"titles">> => {
  const year = yearOf(title);

  const distance = (candidate: Doc<"titles">): number => {
    const candidateYear = yearOf(candidate);

    return year === null || candidateYear === null
      ? Number.MAX_SAFE_INTEGER
      : Math.abs(candidateYear - year);
  };

  return candidates
    .flatMap((candidate) => {
      const score = similarity(title, candidate);

      return score > 0 && candidate._id !== title._id ? [{ candidate, score }] : [];
    })
    .toSorted(
      (left, right) =>
        right.score - left.score ||
        distance(left.candidate) - distance(right.candidate) ||
        (communityScore(right.candidate) ?? 0) - (communityScore(left.candidate) ?? 0),
    )
    .map((entry) => entry.candidate);
};
