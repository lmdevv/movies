/**
 * Home's full-bleed billboard (C1): a page per featured title with its backdrop, split title,
 * facts, Resume or Play, and My List, paged sideways with dots under them.
 */
import type { ProfileId } from "@movies/contracts/ids";
import type { TitleCard } from "@movies/contracts/models/catalog";
import { newBadge } from "@movies/sdk/format";
import { playTarget } from "@movies/sdk/play-target";
import { useCommandQuery } from "@movies/sdk/react";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { useRouter } from "expo-router";
import { useState } from "react";
import { ScrollView, StyleSheet, View, useWindowDimensions } from "react-native";
import type { NativeScrollEvent, NativeSyntheticEvent } from "react-native";

import { useArtwork } from "@/lib/artwork";
import { PAGE_INSET, black, colors, overlay, radius, space, system } from "@/theme/tokens";
import { IconButton, PlayGlyph, PrimaryButton } from "@/ui/button";
import { CheckIcon, PlusIcon } from "@/ui/icons";
import { Text } from "@/ui/text";

import { billboardFacts, billboardTitle } from "./home-text";
import { useMyList } from "./use-my-list";

/** Height of the billboard. */
export const HERO_HEIGHT = 560;

/** Paper's scrim: dark under the status bar, clear over the art, black into the rows. */
const SCRIM = {
  colors: [black(0.55), black(0), black(0), black(0.75), black(1)],
  locations: [0, 0.22, 0.45, 0.78, 1],
} as const;

/** Props for `Hero`. */
interface HeroProps {
  readonly titles: ReadonlyArray<TitleCard>;
  readonly profileId: ProfileId;
}

/** The billboard: one page per title, swiped sideways. */
export function Hero({ titles, profileId }: HeroProps) {
  const { width } = useWindowDimensions();
  const [page, setPage] = useState(0);

  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>): void => {
    const next = Math.round(event.nativeEvent.contentOffset.x / width);

    if (next !== page) setPage(next);
  };

  return (
    <View style={styles.hero}>
      <ScrollView
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onScroll={onScroll}
        scrollEventThrottle={32}
        accessibilityRole="adjustable"
      >
        {titles.map((title) => (
          <HeroPage key={title.id} title={title} profileId={profileId} width={width} />
        ))}
      </ScrollView>
      {titles.length < 2 ? null : (
        <View style={styles.dots} pointerEvents="none">
          {titles.map((title, index) => (
            <View key={title.id} style={[styles.dot, index === page && styles.dotActive]} />
          ))}
        </View>
      )}
    </View>
  );
}

/** Props for `HeroPage`. */
interface HeroPageProps {
  readonly title: TitleCard;
  readonly profileId: ProfileId;
  readonly width: number;
}

function HeroPage({ title, profileId, width }: HeroPageProps) {
  const router = useRouter();
  const artwork = useArtwork();
  // The card comes with Home; progress and My List come with the title's details.
  const detail = useCommandQuery("titles.get", { profileId, titleId: title.id });
  const loaded = detail.status === "success" ? detail.data : null;
  const target = loaded === null ? null : playTarget(loaded);
  const myList = useMyList(profileId, title.id, loaded?.inMyList ?? false);
  const backdrop = artwork(title.artwork.backdrop ?? title.artwork.poster, "backdrop");
  const logo = artwork(title.artwork.logo, "card");
  const name = billboardTitle(title.name);
  const fresh = newBadge(title, Date.now()) !== undefined;

  const play = (): void => {
    if (!title.available) {
      router.push({ pathname: "/title/[titleId]", params: { titleId: title.id } });

      return;
    }

    router.push({
      pathname: "/watch/[titleId]",
      params:
        target?.episodeId === undefined
          ? { titleId: title.id }
          : { titleId: title.id, episodeId: target.episodeId },
    });
  };

  return (
    <View style={[styles.page, { width }]}>
      {backdrop === undefined ? null : (
        <Image
          source={{ uri: backdrop }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          transition={200}
          accessibilityIgnoresInvertColors
        />
      )}
      <LinearGradient
        colors={SCRIM.colors}
        locations={SCRIM.locations}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      <View style={styles.heading}>
        {fresh ? (
          <View style={styles.pill}>
            <Text variant="eyebrow">New this week</Text>
          </View>
        ) : null}
        {logo === undefined ? (
          <>
            <Text
              variant="billboard"
              accessibilityRole="header"
              numberOfLines={2}
              adjustsFontSizeToFit
              minimumFontScale={0.6}
              style={styles.center}
            >
              {name.main}
            </Text>
            {name.subtitle === null ? null : (
              <Text variant="subtitleCaps" numberOfLines={1} style={styles.subtitle}>
                {name.subtitle}
              </Text>
            )}
          </>
        ) : (
          <Image
            source={{ uri: logo }}
            style={styles.logo}
            contentFit="contain"
            accessibilityLabel={title.name}
          />
        )}
        <Text variant="labelMedium" color={overlay.facts} style={styles.facts}>
          {billboardFacts(title)}
        </Text>
      </View>
      <View style={styles.actions}>
        <PrimaryButton
          label={title.available ? (target?.resuming === true ? "Resume" : "Play") : "More info"}
          icon={title.available ? <PlayGlyph /> : undefined}
          onPress={play}
          style={styles.play}
        />
        <IconButton
          label={myList.inList ? "Remove from My List" : "Add to My List"}
          selected={myList.inList}
          surface="tint"
          disabled={loaded === null}
          icon={
            myList.inList ? (
              <CheckIcon size={20} color={colors.text} strokeWidth={2} />
            ) : (
              <PlusIcon size={20} color={colors.text} strokeWidth={2} />
            )
          }
          onPress={myList.toggle}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  hero: { height: HERO_HEIGHT, backgroundColor: system.fill },
  page: {
    height: HERO_HEIGHT,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: space[4],
    paddingHorizontal: PAGE_INSET,
    // Room for the dots, which stay put while pages move.
    paddingBottom: 42,
  },
  heading: { alignItems: "center", gap: 10 },
  pill: {
    backgroundColor: overlay.pill,
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: space[1],
  },
  center: { textAlign: "center" },
  subtitle: { textAlign: "center", paddingLeft: 0.32 * 13 },
  logo: { width: 240, height: 64 },
  facts: { paddingTop: space[1], textAlign: "center" },
  actions: { flexDirection: "row", alignItems: "center", gap: space[3] },
  play: { width: 200 },
  dots: {
    position: "absolute",
    bottom: 20,
    left: 0,
    right: 0,
    flexDirection: "row",
    justifyContent: "center",
    gap: 6,
  },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: overlay.dot },
  dotActive: { width: 16, backgroundColor: colors.text },
});
