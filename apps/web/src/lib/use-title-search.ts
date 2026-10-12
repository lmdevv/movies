import type { ProfileId } from "@movies/contracts/ids";
import type { TitleCard } from "@movies/contracts/models/catalog";
import { useCommandQuery } from "@movies/sdk/react";
import { useEffect, useState } from "react";

/** How long typing must pause before a search runs. */
const SEARCH_DELAY_MS = 150;

/** Most results one search asks for. */
const SEARCH_LIMIT = 24;

/** Live title results for what someone is typing. */
export interface TitleSearch {
  /** The trimmed query the results belong to; empty before anything is typed. */
  readonly query: string;
  /** Results for `query`, or the previous results while the next search runs. */
  readonly results: ReadonlyArray<TitleCard>;
  /** True until the first results for a non-empty query arrive. */
  readonly loading: boolean;
}

/**
 * Searches the profile's titles as `text` changes, after a short pause, keeping the previous
 * results on screen until the next ones arrive so lists do not flicker. Kids profiles only get
 * titles they may see; the server filters them.
 */
export const useTitleSearch = (profileId: ProfileId, text: string): TitleSearch => {
  const [query, setQuery] = useState(text.trim());

  useEffect(() => {
    const next = text.trim();
    const timer = setTimeout(() => setQuery(next), next === "" ? 0 : SEARCH_DELAY_MS);

    return () => clearTimeout(timer);
  }, [text]);

  const search = useCommandQuery(
    "titles.search",
    query === "" ? "skip" : { profileId, query, limit: SEARCH_LIMIT },
  );

  const [settled, setSettled] = useState<{
    readonly query: string;
    readonly results: ReadonlyArray<TitleCard>;
  }>({ query: "", results: [] });

  useEffect(() => {
    if (query === "") setSettled({ query: "", results: [] });
    else if (search.status === "success") setSettled({ query, results: search.data });
    else if (search.status === "error") setSettled({ query, results: [] });
  }, [query, search]);

  return {
    query: settled.query,
    results: settled.results,
    loading: query !== "" && settled.query !== query,
  };
};
