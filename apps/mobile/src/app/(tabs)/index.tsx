/**
 * C01 · Home: the featured hero under the large title, then Continue Watching, Recently Added, My
 * List, and Collections. Scrolling collapses the title into the glass bar (C02). While a library
 * scans it shows the scan and what has arrived (C13); without libraries, the empty state (C12).
 * Kids profiles see the inset billboard (C10).
 */
import type { Home as HomeRows, Library } from "@movies/contracts/models/catalog";
import { useCommandQuery } from "@movies/sdk/react";
import { router } from "expo-router";
import { Folder, Popcorn } from "lucide-react-native";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { CollectionCard } from "@/components/browse/collection-card";
import { EmptyState } from "@/components/browse/empty-state";
import { Hero, KidsHero } from "@/components/browse/hero";
import { TAB_BAR_CLEARANCE } from "@/components/browse/layout";
import { ProfileButton } from "@/components/browse/profile-button";
import { Rail } from "@/components/browse/rail";
import { ScanStatus } from "@/components/browse/scan-status";
import { CompactBar, LargeTitle, useCollapse } from "@/components/browse/tab-chrome";
import { ContinueCard } from "@/components/continue-card";
import { TitlePoster } from "@/components/title-poster";
import { Button } from "@/components/ui/button";
import { CalmState } from "@/components/ui/calm-state";
import { heroTitles, homeLayout, newestFirst } from "@/lib/browse";
import { describeFailure } from "@/lib/failure";
import { useActiveProfile } from "@/session/active-profile";

/** Collections in Home's row; the Collections page lists the rest. */
const ROW_COLLECTIONS = 20;

export default function Home() {
  const { profile } = useActiveProfile();
  const home = useCommandQuery("titles.home", { profileId: profile.id });
  const libraries = useCommandQuery("libraries.list", {});
  const collapse = useCollapse();
  const insets = useSafeAreaInsets();

  if (home.status === "loading" || libraries.status === "loading") {
    return <View className="flex-1 bg-bg" />;
  }

  if (home.status === "error" || libraries.status === "error") {
    const cause =
      home.status === "error" ? home.error : libraries.status === "error" ? libraries.error : null;

    return (
      <View className="flex-1 bg-bg">
        <CalmState
          title="Couldn't Load Home"
          description={describeFailure(cause)}
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
    );
  }

  const layout = homeLayout(home.data, libraries.data);
  const arrived = newestFirst(home.data.recentlyAddedMovies, home.data.recentlyAddedShows);
  const pages = heroTitles(home.data.featured, arrived);
  const fullBleed = layout === "rows" && !profile.kids && pages.length > 0;

  return (
    <View className="flex-1 bg-bg">
      <ScrollView
        onScroll={collapse.onScroll}
        scrollEventThrottle={16}
        contentInsetAdjustmentBehavior="never"
        contentContainerStyle={{ paddingBottom: insets.bottom + TAB_BAR_CLEARANCE }}
      >
        {fullBleed ? (
          <Hero titles={pages} header={<LargeTitle title="Home" overMedia />} />
        ) : (
          <LargeTitle title="Home" />
        )}
        <HomeBody layout={layout} home={home.data} libraries={libraries.data} kids={profile.kids} />
      </ScrollView>
      <CompactBar
        title="Home"
        collapsed={collapse.collapsed}
        trailing={<ProfileButton overMedia={fullBleed && !collapse.collapsed} />}
      />
    </View>
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

  if (layout === "empty") return <EmptyState icon={Folder} title="Your library is empty." />;

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
        render={(title) => <TitlePoster title={title} />}
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
