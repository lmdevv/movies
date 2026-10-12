/** Fold case and strip diacritics, so "Shōgun" and "shogun" compare equal. */
const fold = (text: string): string =>
  text
    .normalize("NFD")
    .replaceAll(/\p{Diacritic}/gu, "")
    .toLowerCase();

const isWordStart = (text: string, index: number): boolean => {
  if (index === 0) return true;

  const previous = text[index - 1] ?? "";

  return !/[\p{L}\p{N}]/u.test(previous);
};

/** Scores one whitespace-free term against already folded text, or `null` when it is not found. */
const scoreTerm = (term: string, text: string): number | null => {
  let score = 0;
  let from = 0;
  let previous = -2;

  for (const char of term) {
    const index = text.indexOf(char, from);

    if (index === -1) return null;

    score += 1;

    if (isWordStart(text, index)) score += 4;

    if (index === previous + 1) score += 3;

    previous = index;
    from = index + 1;
  }

  const at = text.indexOf(term);

  if (at === 0) score += 16;
  else if (at > 0) score += isWordStart(text, at) ? 12 : 6;

  return score;
};

/**
 * Score how well a typed query matches some text, ignoring case and diacritics.
 *
 * Every whitespace-separated term of `query` must appear in `text` as an in-order subsequence.
 * Matches at the start of the text, at word starts, and in consecutive runs score higher.
 *
 * @returns `0` for an empty query, `null` when a term does not match, otherwise a positive score.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const terms = fold(query)
    .split(/\s+/u)
    .filter((term) => term.length > 0);

  const folded = fold(text);
  let total = 0;

  for (const term of terms) {
    const score = scoreTerm(term, folded);

    if (score === null) return null;

    total += score;
  }

  return total;
}

/**
 * Keep the items that match `query` and order them best first; ties keep their original order.
 *
 * The first text of each item is its title and outranks the rest, which only need to match
 * together with it (so "severance s2" finds a title "Severance" with detail "S2:E4").
 *
 * @param texts - The searchable texts of an item, title first.
 */
export function fuzzyFilter<T>(
  items: ReadonlyArray<T>,
  query: string,
  texts: (item: T) => ReadonlyArray<string>,
): ReadonlyArray<T> {
  if (query.trim().length === 0) return items;

  const ranked: Array<{ readonly item: T; readonly score: number; readonly index: number }> = [];

  for (const [index, item] of items.entries()) {
    const fields = texts(item);
    const all = fuzzyScore(query, fields.join(" "));

    if (all === null) continue;

    const title = fuzzyScore(query, fields[0] ?? "") ?? 0;

    ranked.push({ item, score: all + title * 2, index });
  }

  ranked.sort((left, right) => right.score - left.score || left.index - right.index);

  return ranked.map((entry) => entry.item);
}
