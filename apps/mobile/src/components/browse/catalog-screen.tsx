/**
 * C03 · Movies and C04 · Shows: a featured hero with the Genres and library chips over it, rows of
 * the newest and of the most common genres, then every title in a three-column grid. A sort other
 * than Recently Added, a genre, or a library drops the hero and rows for the grid alone (C14,
 * C15). The ellipsis opens Sort; the chips open Genres and Filter.
 */
import { useCommandQuery } from "@movies/sdk/react";
import { router } from "expo-router";
import { Ellipsis, Film, Tv } from "lucide-react-native";
import { ActivityIndicator, View } from "react-native";

import { Button } from "@/components/ui/button";
import { CalmState } from "@/components/ui/calm-state";
import { IconButton } from "@/components/ui/icon-button";
import { Text } from "@/components/ui/text";
import { DEFAULT_FILTERS, heroTitles, isNarrowed, kindLabel, plural } from "@/lib/browse";
import { describeFailure } from "@/lib/failure";
import { useActiveProfile } from "@/session/active-profile";

import { TitlePoster } from "../title-poster";
import { Chip } from "./chip";
import { EmptyState } from "./empty-state";
import { useTabFilters } from "./filters";
import { Hero } from "./hero";
import { PagingFooter, PosterGrid } from "./poster-grid";
import { Rail } from "./rail";
import { CompactBar, LargeTitle, useCollapse } from "./tab-chrome";
import { useTitlePages } from "./title-pages";

/** Genre rows under the hero, most common genres first. */
const GENRE_ROWS = 3;

/** Titles in each row. */
const ROW_TITLES = 20;

/** A row of the newest titles or of one genre. */
function GenreRail({ genre }: { readonly genre: string }) {
  const { profile } = useActiveProfile();
  const { kind } = useTabFilters();

  const titles = useCommandQuery("titles.list", {
    profileId: profile.id,
    kind,
    genre,
    sort: "added",
    limit: ROW_TITLES,
  });

  return (
    <Rail
      title={genre}
      items={titles.status === "success" ? titles.data.items : []}
      keyOf={(title) => title.id}
      render={(title) => <TitlePoster title={title} />}
      onSeeAll={() => router.push(`/genre/${encodeURIComponent(genre)}?kind=${kind}`)}
    />
  );
}

/** The chips over the hero or above the grid. */
function FilterChips({ base }: { readonly base: string }) {
  const { kind, filters } = useTabFilters();
  const libraries = useCommandQuery("libraries.list", {});

  const library =
    filters.libraryId === null || libraries.status !== "success"
      ? null
      : (libraries.data.find((candidate) => candidate.id === filters.libraryId) ?? null);

  return (
    <View className="flex-row flex-wrap gap-2 px-5">
      <Chip
        label={filters.genre ?? "Genres"}
        prominent
        accessibilityLabel={filters.genre === null ? "Genres" : `Genre: ${filters.genre}`}
        onPress={() => router.push(`${base}/genres`)}
      />
      <Chip
        label={library?.name ?? "All Libraries"}
        accessibilityLabel={`Filter ${kindLabel(kind)}`}
        onPress={() => router.push(`${base}/filter`)}
      />
    </View>
  );
}

/** The Movies or Shows tab. `base` is the tab's route, such as `/movies`. */
export function CatalogScreen({ base }: { readonly base: string }) {
  const { profile } = useActiveProfile();
  const { kind, filters } = useTabFilters();
  const collapse = useCollapse();
  const title = kindLabel(kind);
  const pages = useTitlePages(profile.id, kind, filters);
  const browsing = !isNarrowed(filters) && filters.sort === DEFAULT_FILTERS.sort;
  const home = useCommandQuery("titles.home", browsing ? { profileId: profile.id } : "skip");

  const genres = useCommandQuery(
    "titles.genres",
    browsing ? { profileId: profile.id, kind } : "skip",
  );

  const newest =
    home.status === "success"
      ? kind === "movie"
        ? home.data.recentlyAddedMovies
        : home.data.recentlyAddedShows
      : [];

  const featured =
    home.status === "success" && home.data.featured?.kind === kind ? home.data.featured : null;

  const heroPages = browsing ? heroTitles(featured, newest) : [];
  const overMedia = heroPages.length > 0 && !collapse.collapsed;

  const header = (
    <View className="gap-8 pb-1">
      {heroPages.length > 0 ? (
        <Hero
          titles={heroPages}
          size="tab"
          header={
            <View className="gap-1">
              <LargeTitle title={title} overMedia />
              <FilterChips base={base} />
            </View>
          }
        />
      ) : (
        <View className="gap-4">
          <LargeTitle title={title} />
          <FilterChips base={base} />
        </View>
      )}
      {browsing ? (
        <>
          <Rail
            title="Recently Added"
            items={newest}
            keyOf={(item) => item.id}
            render={(item) => <TitlePoster title={item} />}
          />
          {(genres.status === "success" ? genres.data.slice(0, GENRE_ROWS) : []).map((genre) => (
            <GenreRail key={genre.name} genre={genre.name} />
          ))}
        </>
      ) : null}
      {pages.loaded && pages.titles.length > 0 ? (
        <View className="gap-1 px-5">
          {browsing ? (
            <Text variant="heading" accessibilityRole="header">
              {`All ${title}`}
            </Text>
          ) : null}
          {pages.complete ? (
            <Text variant="secondary" tone="muted">
              {plural(pages.titles.length, kind === "movie" ? "Movie" : "Show", title)}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );

  return (
    <View className="flex-1 bg-bg">
      {pages.subscriptions}
      <PosterGrid
        titles={pages.titles}
        inside="tabBar"
        header={header}
        footer={<PagingFooter pages={pages} />}
        empty={
          <GridEmpty
            loaded={pages.loaded}
            failure={pages.failure}
            onRetry={pages.retry}
            title={title}
            narrowed={!browsing}
          />
        }
        onEndReached={pages.loadMore}
        onScroll={collapse.onScroll}
      />
      <CompactBar
        title={title}
        collapsed={collapse.collapsed}
        trailing={
          <IconButton
            icon={Ellipsis}
            label={`Sort ${title}`}
            variant={overMedia ? "glass" : "raised"}
            onPress={() => router.push(`${base}/sort`)}
          />
        }
      />
    </View>
  );
}

/** What the grid shows without titles: loading, a failure, or nothing matching. */
function GridEmpty({
  loaded,
  failure,
  onRetry,
  title,
  narrowed,
}: {
  readonly loaded: boolean;
  readonly failure: { readonly cause: unknown } | null;
  readonly onRetry: () => void;
  readonly title: string;
  readonly narrowed: boolean;
}) {
  if (failure !== null) {
    return (
      <View className="h-80">
        <CalmState
          title={`Couldn't Load ${title}`}
          description={describeFailure(failure.cause)}
          actions={<Button label="Try Again" onPress={onRetry} />}
        />
      </View>
    );
  }

  if (!loaded) return <ActivityIndicator className="py-10" colorClassName="accent-text-muted" />;

  return (
    <EmptyState
      icon={title === "Movies" ? Film : Tv}
      title={narrowed ? `No ${title} Match` : `No ${title} Yet`}
    />
  );
}
