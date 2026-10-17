/**
 * The Movies or Shows tab's sort and filters, shared between the tab and its Sort, Filter, and
 * Genres sheets (C14, C15), which live in the tab's own stack.
 */
import type { TitleKind } from "@movies/contracts/models/catalog";
import { createContext, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { DEFAULT_FILTERS } from "@/lib/browse";
import type { BrowseFilters } from "@/lib/browse";

/** A tab's kind, filters, and the way to change them. */
export interface TabFilters {
  readonly kind: TitleKind;
  readonly filters: BrowseFilters;
  readonly setFilters: (filters: BrowseFilters) => void;
}

const FiltersContext = createContext<TabFilters | null>(null);

/** Holds one tab's filters, starting from the defaults. */
export function FiltersProvider({
  kind,
  children,
}: {
  readonly kind: TitleKind;
  readonly children: ReactNode;
}) {
  const [filters, setFilters] = useState<BrowseFilters>(DEFAULT_FILTERS);
  const value = useMemo(() => ({ kind, filters, setFilters }), [kind, filters]);

  return <FiltersContext.Provider value={value}>{children}</FiltersContext.Provider>;
}

/**
 * The enclosing tab's filters.
 *
 * @throws When used outside `FiltersProvider`, a programming error.
 */
export const useTabFilters = (): TabFilters => {
  const value = useContext(FiltersContext);

  if (value === null) throw new Error("useTabFilters must be used inside FiltersProvider");

  return value;
};
