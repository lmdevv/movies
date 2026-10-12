/**
 * The Movies and Shows pages (05 Browse · 02 and 03): heading with the count, sort, genre chips,
 * and a poster grid that loads more as it scrolls into view.
 */
import type { ProfileId } from "@movies/contracts/ids";
import type { TitleCard, TitleKind, TitleSort } from "@movies/contracts/models/catalog";
import { useCommandQuery } from "@movies/sdk/react";
import { CalmState } from "@movies/ui/components/calm-state";
import { Chip } from "@movies/ui/components/chip";
import { ChevronDownIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import { describeFailure } from "@/lib/failure";
import { plural, titleFacts } from "@/lib/format";
import { useActiveProfile } from "@/session/guards";

import { PosterGridSkeleton } from "./skeletons";
import { SelectMenu } from "./select-menu";
import type { SelectOption } from "./select-menu";
import { TitlePosterCard, newBadge } from "./title-cards";

/** Titles per page; the grid asks for the next page as its end scrolls into view. */
const PAGE_SIZE = 60;

/** Genre chips after "All", most common first. */
const GENRE_CHIPS = 8;

const SORTS: ReadonlyArray<SelectOption<TitleSort>> = [
  { value: "added", label: "Recently added" },
  { value: "name", label: "Name" },
  { value: "year", label: "Year" },
];

/** One page of the list: what it held, and the cursor after it. */
type LoadedPage = {
  readonly items: ReadonlyArray<TitleCard>;
  readonly nextCursor: string | null;
};

/** Subscribes to one page and reports it; the grid draws every page's titles together. */
function PageSubscription({
  profileId,
  kind,
  sort,
  cursor,
  index,
  onPage,
  onError,
}: {
  readonly profileId: ProfileId;
  readonly kind: TitleKind;
  readonly sort: TitleSort;
  readonly cursor: string | null;
  readonly index: number;
  readonly onPage: (index: number, page: LoadedPage) => void;
  readonly onError: (cause: unknown) => void;
}) {
  const page = useCommandQuery("titles.list", { profileId, kind, sort, cursor, limit: PAGE_SIZE });

  useEffect(() => {
    if (page.status === "success") onPage(index, page.data);
    else if (page.status === "error") onError(page.error);
  }, [page, index, onPage, onError]);

  return null;
}

/** Genres across `titles`, most common first. */
const topGenres = (titles: ReadonlyArray<TitleCard>): ReadonlyArray<string> => {
  const counts = new Map<string, number>();

  for (const genre of titles.flatMap((title) => title.genres)) {
    counts.set(genre, (counts.get(genre) ?? 0) + 1);
  }

  return [...counts.entries()]
    .toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, GENRE_CHIPS)
    .map(([genre]) => genre);
};

/** Calls `onVisible` whenever the returned element scrolls near the viewport. */
const useNearViewport = (
  onVisible: () => void,
): ((element: HTMLElement | null) => (() => void) | undefined) => {
  const latest = useRef(onVisible);

  latest.current = onVisible;

  return useCallback((element: HTMLElement | null) => {
    if (element === null) return undefined;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) latest.current();
      },
      { rootMargin: "600px 0px" },
    );

    observer.observe(element);

    return () => observer.disconnect();
  }, []);
};

/** Page heading: a heavy title with a mono count, and controls on the right. */
export function GridHeader({
  title,
  count,
  controls,
}: {
  readonly title: string;
  readonly count?: string | undefined;
  readonly controls?: ReactNode;
}) {
  return (
    <div className="flex items-end justify-between gap-4 pt-2 pb-5 max-md:hidden md:pt-9 md:pb-6">
      <div className="flex items-baseline gap-3.5">
        <h1 className="text-title/title font-heavy tracking-display text-text">{title}</h1>
        {count === undefined ? null : (
          <p className="font-mono text-label/label text-text-muted">{count}</p>
        )}
      </div>
      {controls}
    </div>
  );
}

/** The responsive poster grid: two columns on phones, 168px posters on desktops. */
export function PosterGrid({ children }: { readonly children: ReactNode }) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 md:grid-cols-[repeat(auto-fill,minmax(--spacing(42),1fr))] md:gap-x-5.5 md:gap-y-8">
      {children}
    </div>
  );
}

/** Movies or Shows: every title of `kind` the profile may see. */
export function TitleGridPage({ kind }: { readonly kind: TitleKind }) {
  const { profile } = useActiveProfile();
  const [sort, setSort] = useState<TitleSort>("added");
  const [genre, setGenre] = useState<string | null>(null);
  const [pages, setPages] = useState<ReadonlyArray<LoadedPage | undefined>>([]);
  const [cursors, setCursors] = useState<ReadonlyArray<string | null>>([null]);
  const [failure, setFailure] = useState<{ readonly cause: unknown } | null>(null);

  // A new sort starts over from the first page.
  const changeSort = (next: TitleSort): void => {
    setSort(next);
    setPages([]);
    setCursors([null]);
  };

  const onPage = useCallback((index: number, page: LoadedPage) => {
    setPages((current) => {
      const next = [...current];

      next[index] = page;

      return next;
    });
  }, []);

  const onError = useCallback((cause: unknown) => setFailure({ cause }), []);

  const loaded = pages.flatMap((page) => page?.items ?? []);
  const last = pages[cursors.length - 1];
  const complete = last !== undefined && last.nextCursor === null;
  const genres = useMemo(() => topGenres(loaded), [loaded]);
  const visible = genre === null ? loaded : loaded.filter((title) => title.genres.includes(genre));
  const now = Date.now();

  const sentinel = useNearViewport(() => {
    if (last?.nextCursor !== undefined && last.nextCursor !== null) {
      const cursor = last.nextCursor;

      setCursors((current) => (current.includes(cursor) ? current : [...current, cursor]));
    }
  });

  const label = kind === "movie" ? "Movies" : "Shows";
  const firstLoaded = pages[0] !== undefined;

  return (
    <div className="mx-auto box-content max-w-content px-4 md:px-16">
      {cursors.map((cursor, index) => (
        <PageSubscription
          key={`${sort}:${cursor ?? "first"}`}
          profileId={profile.id}
          kind={kind}
          sort={sort}
          cursor={cursor}
          index={index}
          onPage={onPage}
          onError={onError}
        />
      ))}
      <GridHeader
        title={label}
        count={
          complete
            ? plural(
                loaded.length,
                kind === "movie" ? "title" : "show",
                kind === "movie" ? "titles" : "shows",
              )
            : undefined
        }
        controls={
          <SelectMenu
            label="Sort"
            value={sort}
            options={SORTS}
            onChange={changeSort}
            className="h-9 gap-2.5 border border-hairline pr-3 pl-3.5"
          >
            <span className="text-label/label text-text-muted">Sort</span>
            <span className="text-label/label font-semibold">
              {SORTS.find((option) => option.value === sort)?.label}
            </span>
            <ChevronDownIcon className="size-4" strokeWidth={1.75} aria-hidden />
          </SelectMenu>
        }
      />
      {genres.length < 2 ? null : (
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-6 scrollbar-none md:mx-0 md:px-0 md:pb-8">
          <Chip selected={genre === null} onClick={() => setGenre(null)}>
            All
          </Chip>
          {genres.map((name) => (
            <Chip key={name} selected={genre === name} onClick={() => setGenre(name)}>
              {name}
            </Chip>
          ))}
        </div>
      )}
      {failure !== null ? (
        <CalmState
          className="py-24"
          title={`${label} didn't load`}
          description={describeFailure(failure.cause)}
        />
      ) : !firstLoaded ? (
        <PosterGridSkeleton />
      ) : loaded.length === 0 ? (
        <CalmState className="py-24" title={kind === "movie" ? "No movies yet" : "No shows yet"} />
      ) : (
        <>
          <PosterGrid>
            {visible.map((title) => (
              <TitlePosterCard
                key={title.id}
                title={title}
                subtitle={titleFacts(title) || undefined}
                badge={newBadge(title, now)}
                className="w-full"
              />
            ))}
          </PosterGrid>
          {complete ? null : (
            <div ref={sentinel} aria-hidden className="pt-8">
              <PosterGridSkeleton count={7} />
            </div>
          )}
          {genre !== null && visible.length === 0 ? (
            <p className="py-16 text-center text-body/body text-text-muted">
              No {genre} {label.toLowerCase()}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
