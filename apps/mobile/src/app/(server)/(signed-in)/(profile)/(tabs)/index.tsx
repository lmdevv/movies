/**
 * Home (C1, C2): the billboard under a large `For <profile>` title, then the profile's rows, live.
 * Scrolling past the billboard brings in the compact glass bar.
 */
import type { ProfileId } from "@movies/contracts/ids";
import type { Home as HomeRows, TitleCard } from "@movies/contracts/models/catalog";
import { describeFailure } from "@movies/sdk/failure";
import { newBadge, plural, progressFraction, titleFacts } from "@movies/sdk/format";
import { useCommandQuery } from "@movies/sdk/react";
import { useRouter } from "expo-router";
import { useRef } from "react";
import { Animated, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { HERO_HEIGHT, Hero } from "@/home/hero";
import { continueText, heroTitles } from "@/home/home-text";
import { useArtwork } from "@/lib/artwork";
import { useActiveProfile } from "@/session/active-profile";
import { useTabBarScroll } from "@/shell/tab-bar-scroll";
import { colors } from "@/theme/tokens";
import { Avatar } from "@/ui/avatar";
import { PrimaryButton } from "@/ui/button";
import { CalmState } from "@/ui/calm-state";
import { CardRow, CollectionCard, LandscapeCard, PosterCard } from "@/ui/cards";
import { CompactBar, LargeTitle, SectionHeader } from "@/ui/headers";
import { BlankScreen } from "@/ui/screen";

/** Collections the Home row shows. */
const ROW_COLLECTIONS = 20;

/** Room under the last row for the floating tab bar. */
const TAB_BAR_ROOM = 120;

export default function Home() {
  const { profile } = useActiveProfile();
  const home = useCommandQuery("titles.home", { profileId: profile.id });
  const libraries = useCommandQuery("libraries.list", {});

  if (home.status === "loading" || libraries.status === "loading") return <BlankScreen />;

  if (home.status === "error" || libraries.status === "error") {
    const failed = [home, libraries].filter((query) => query.status === "error");

    return (
      <View style={styles.screen}>
        <CalmState
          title="Home didn't load"
          description={describeFailure(failed[0]?.error)}
          actions={
            <PrimaryButton
              label="Try again"
              onPress={() => {
                for (const query of failed) query.retry();
              }}
            />
          }
        />
      </View>
    );
  }

  return <HomeScreen home={home.data} />;
}

function HomeScreen({ home }: { readonly home: HomeRows }) {
  const { profile } = useActiveProfile();
  const { top, bottom } = useSafeAreaInsets();
  const reportScroll = useTabBarScroll();
  const scrollY = useRef(new Animated.Value(0)).current;
  const titles = heroTitles(home);
  const title = `For ${profile.name}`;
  // The compact bar fades in as the billboard's bottom passes under it.
  const barAt = Math.max(1, (titles.length === 0 ? 60 : HERO_HEIGHT - 120) - top);

  const avatar = (size: number) => (
    <Avatar avatar={profile.avatar} name={profile.name} size={size} variant="circle" />
  );

  return (
    <View style={styles.screen}>
      <Animated.ScrollView
        contentInsetAdjustmentBehavior="never"
        contentContainerStyle={{ paddingBottom: TAB_BAR_ROOM + bottom }}
        scrollEventThrottle={16}
        onScroll={Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], {
          useNativeDriver: true,
          listener: (event: { nativeEvent: { contentOffset: { y: number } } }) => {
            reportScroll(event.nativeEvent.contentOffset.y);
          },
        })}
      >
        {titles.length === 0 ? null : <Hero titles={titles} profileId={profile.id} />}
        <LargeTitle
          title={title}
          accessory={avatar(34)}
          style={[titles.length === 0 ? null : styles.overHero, { paddingTop: top + 4 }]}
        />
        <Rows home={home} profileId={profile.id} first={titles.length === 0} />
      </Animated.ScrollView>
      <Animated.View
        pointerEvents="none"
        style={[
          styles.bar,
          {
            opacity: scrollY.interpolate({
              inputRange: [barAt - 24, barAt],
              outputRange: [0, 1],
              extrapolate: "clamp",
            }),
          },
        ]}
      >
        <CompactBar title={title} accessory={avatar(30)} />
      </Animated.View>
    </View>
  );
}

/** Props for `Rows`. */
interface RowsProps {
  readonly home: HomeRows;
  readonly profileId: ProfileId;
  /** Whether the rows start the page, without a billboard above them. */
  readonly first: boolean;
}

function Rows({ home, profileId, first }: RowsProps) {
  const router = useRouter();
  const artwork = useArtwork();
  const now = Date.now();

  const openTitle = (id: TitleCard["id"]): void => {
    router.push({ pathname: "/title/[titleId]", params: { titleId: id } });
  };

  const posters = (cards: ReadonlyArray<TitleCard>) => (
    <CardRow>
      {cards.map((card) => (
        <PosterCard
          key={card.id}
          image={artwork(card.artwork.poster, "poster")}
          name={card.name}
          caption={titleFacts(card)}
          badge={newBadge(card, now)}
          onPress={() => openTitle(card.id)}
        />
      ))}
    </CardRow>
  );

  return (
    <View style={styles.rows}>
      {home.continueWatching.length === 0 ? null : (
        <>
          <SectionHeader title="Continue watching" first />
          <CardRow>
            {home.continueWatching.map((item) => {
              const text = continueText(item);

              return (
                <LandscapeCard
                  key={`${item.title.id}:${item.episode?.id ?? ""}`}
                  image={artwork(
                    item.episode?.still ?? item.title.artwork.backdrop ?? item.title.artwork.poster,
                    "card",
                  )}
                  artTitle={text.artTitle}
                  title={text.title}
                  subtitle={text.subtitle}
                  progress={progressFraction(item.progress)}
                  accessibilityLabel={`Resume ${text.title}`}
                  onPress={() =>
                    router.push({
                      pathname: "/watch/[titleId]",
                      params:
                        item.episode === null
                          ? { titleId: item.title.id }
                          : { titleId: item.title.id, episodeId: item.episode.id },
                    })
                  }
                />
              );
            })}
          </CardRow>
        </>
      )}
      {home.recentlyAddedMovies.length === 0 ? null : (
        <>
          <SectionHeader
            title="Recently added"
            first={first && home.continueWatching.length === 0}
            onPress={() => router.navigate("/movies")}
          />
          {posters(home.recentlyAddedMovies)}
        </>
      )}
      {home.recentlyAddedShows.length === 0 ? null : (
        <>
          <SectionHeader title="Shows" onPress={() => router.navigate("/shows")} />
          {posters(home.recentlyAddedShows)}
        </>
      )}
      {home.myList.length === 0 ? null : (
        <>
          <SectionHeader title="My List" onPress={() => router.navigate("/my-list")} />
          {posters(home.myList)}
        </>
      )}
      <CollectionsRow profileId={profileId} />
    </View>
  );
}

/** Collections on Home, once any holds a title the profile may see. */
function CollectionsRow({ profileId }: { readonly profileId: ProfileId }) {
  const artwork = useArtwork();
  const collections = useCommandQuery("collections.list", { profileId, limit: ROW_COLLECTIONS });

  if (collections.status !== "success" || collections.data.length === 0) return null;

  return (
    <>
      <SectionHeader title="Collections" />
      <CardRow>
        {collections.data.map((collection) => (
          <CollectionCard
            key={collection.id}
            image={artwork(
              collection.artwork.backdrop ??
                collection.titles[0]?.artwork.backdrop ??
                collection.artwork.poster,
              "card",
            )}
            name={collection.name}
            count={plural(collection.titles.length, "title", "titles")}
          />
        ))}
      </CardRow>
    </>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  overHero: { position: "absolute", top: 0, left: 0, right: 0 },
  rows: { paddingTop: 0 },
  bar: { position: "absolute", top: 0, left: 0, right: 0 },
});
