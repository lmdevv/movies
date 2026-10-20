/**
 * C01 · Home: the featured hero under the large title, then Continue Watching, Recently Added, My
 * List as wide stills (hidden while the list is empty), and Collections. Scrolled, the content runs
 * under a bar that fades from the page into it, with the compact title (C02). In the light
 * appearance the hero fades into white (C18). While a library scans it shows the scan and what has
 * arrived (C13); without libraries, the empty state (C12). Kids profiles see the inset billboard
 * (C10). In a watch room, the room's pill sits under the title (C17).
 */
import type { Home as HomeRows, Library } from "@movies/contracts/models/catalog";
import { useCommandQuery } from "@movies/sdk/react";
import { router } from "expo-router";
import { Folder, Plus, Popcorn } from "lucide-react-native";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { CollectionCard } from "@/components/browse/collection-card";
import { EmptyState } from "@/components/browse/empty-state";
import { Hero, KidsHero } from "@/components/browse/hero";
import { TAB_BAR_CLEARANCE } from "@/components/browse/layout";
import { ProfileButton } from "@/components/browse/profile-button";
import { Rail } from "@/components/browse/rail";
import { ReturnToRoom } from "@/components/rooms/room-pill";
import { ScanStatus } from "@/components/browse/scan-status";
import { CompactBar, LargeTitle, useBarOverlap, useCollapse } from "@/components/browse/tab-chrome";
import { ContinueCard } from "@/components/continue-card";
import { TitlePoster } from "@/components/title-poster";
import { Button } from "@/components/ui/button";
import { CalmState } from "@/components/ui/calm-state";
import { heroTitles, homeLayout, newestFirst } from "@/lib/browse";
import { describeFailure } from "@/lib/failure";
import { useActiveProfile } from "@/session/active-profile";

/** The bar over Home is the scroll view's first child, and stays at the top. */
const STICKY_BAR = [0];

/** Collections in Home's row; the Collections page lists the rest. */
const ROW_COLLECTIONS = 20;

export default function Home() {
  const { profile } = useActiveProfile();
  const home = useCommandQuery("titles.home", { profileId: profile.id });
  const libraries = useCommandQuery("libraries.list", {});
  const collapse = useCollapse();
  const insets = useSafeAreaInsets();
  const overlap = useBarOverlap();

  const failed = home.status === "error" || libraries.status === "error";

  const loaded =
    home.status === "success" && libraries.status === "success"
      ? { rows: home.data, libraries: libraries.data }
      : null;

  const layout = loaded === null ? null : homeLayout(loaded.rows, loaded.libraries);

  const arrived =
    loaded === null
      ? []
      : newestFirst(loaded.rows.recentlyAddedMovies, loaded.rows.recentlyAddedShows);

  const pages = loaded === null ? [] : heroTitles(loaded.rows.featured, arrived);
  const fullBleed = layout === "rows" && !profile.kids && pages.length > 0;

  // The scroll view is the page itself, from the first render on: UIKit looks for it there as the
  // tab appears, to minimize the tab bar as it scrolls and soften the content behind it (C02).
  return (
    <ScrollView
      onScroll={collapse.onScroll}
      scrollEventThrottle={16}
      contentInsetAdjustmentBehavior="never"
      stickyHeaderIndices={STICKY_BAR}
      className="flex-1 bg-bg"
      contentContainerStyle={{ flexGrow: 1, paddingBottom: insets.bottom + TAB_BAR_CLEARANCE }}
    >
      <CompactBar
        title="Home"
        collapsed={collapse.collapsed}
        trailing={<ProfileButton overMedia={fullBleed && !collapse.collapsed} />}
      />
      <View className="flex-1" style={{ marginTop: -overlap }}>
        {failed ? (
          <View className="flex-1" style={{ paddingTop: insets.top }}>
            <CalmState
              title="Couldn't Load Home"
              description={describeFailure(
                home.status === "error"
                  ? home.error
                  : libraries.status === "error"
                    ? libraries.error
                    : null,
              )}
              actions={
                <Button
                  label="Try Again"
                  onPress={() => {
                    if (home.status === "error") home.retry();

                    if (libraries.status === "error") libraries.retry();
                  }}
                />
              }
            />
          </View>
        ) : loaded === null || layout === null ? null : (
          <>
            {fullBleed ? (
              <Hero
                titles={pages}
                header={
                  <>
                    <LargeTitle title="Home" overMedia />
                    <ReturnToRoom />
                  </>
                }
              />
            ) : (
              <>
                <LargeTitle title="Home" />
                <ReturnToRoom />
              </>
            )}
            <HomeBody
              layout={layout}
              home={loaded.rows}
              libraries={loaded.libraries}
              kids={profile.kids}
            />
          </>
        )}
      </View>
    </ScrollView>
  );
}

/** C12's Add a Library, for sessions that may manage libraries (I03). */
function AddLibrary() {
  const viewer = useCommandQuery("account.viewer", {});

  if (viewer.status !== "success" || !viewer.data.scopes.includes("manage")) return null;

  return (
    <Button label="Add a Library" icon={Plus} onPress={() => router.push("/owner/libraries/new")} />
  );
}

/** What follows the hero or the title, by layout. */
function HomeBody({
  layout,
  home,
  libraries,
  kids,
}: {
  readonly layout: ReturnType<typeof homeLayout>;
  readonly home: HomeRows;
  readonly libraries: ReadonlyArray<Library>;
  readonly kids: boolean;
}) {
  const arrived = newestFirst(home.recentlyAddedMovies, home.recentlyAddedShows);

  if (layout === "empty") {
    return <EmptyState icon={Folder} title="Your library is empty." action={<AddLibrary />} />;
  }

  if (layout === "nothing") return <EmptyState icon={Popcorn} title="Nothing to Watch Yet" />;

  if (layout === "scanning") {
    return (
      <View className="gap-8 pt-4">
        <ScanStatus libraries={libraries} />
        <Rail
          title="Recently Added"
          items={arrived}
          keyOf={(title) => title.id}
          render={(title) => <TitlePoster title={title} />}
        />
      </View>
    );
  }

  return (
    <View className="gap-8 pt-4">
      {kids && home.featured !== null ? <KidsHero title={home.featured} /> : null}
      <Rail
        title="Continue Watching"
        items={home.continueWatching}
        keyOf={(item) => `${item.title.id}:${item.episode?.id ?? ""}`}
        render={(item) => <ContinueCard item={item} />}
      />
      <Rail
        title="Recently Added"
        items={arrived}
        keyOf={(title) => title.id}
        render={(title) => <TitlePoster title={title} />}
      />
      <Rail
        title="My List"
        items={home.myList}
        keyOf={(title) => title.id}
        render={(title) => <TitlePoster title={title} artwork="still" />}
      />
      <CollectionsRow />
    </View>
  );
}

/** Collections that hold a title this profile may see, with the way to all of them. */
function CollectionsRow() {
  const { profile } = useActiveProfile();

  const collections = useCommandQuery("collections.list", {
    profileId: profile.id,
    limit: ROW_COLLECTIONS,
  });

  if (collections.status !== "success" || collections.data.length === 0) return null;

  return (
    <Rail
      title="Collections"
      items={collections.data}
      keyOf={(collection) => collection.id}
      render={(collection) => <CollectionCard collection={collection} size="rail" />}
      onSeeAll={() => router.push("/collections")}
    />
  );
}
