/**
 * The top of a title's page (D01, D03): full-bleed artwork that drifts at half speed and fades as
 * the page scrolls (and stretches when pulled down), the centered title or its logo, the facts
 * line, Play or Resume with the My List circle, and the overview. The glass top bar over it turns
 * compact, with the title, once the title has scrolled under it (D02).
 */
import type { ProfileId } from "@movies/contracts/ids";
import type { TitleDetail } from "@movies/contracts/models/catalog";
import { BlurView } from "expo-blur";
import { LinearGradient } from "expo-linear-gradient";
import { router } from "expo-router";
import { Check, ChevronLeft, Ellipsis, Play, Plus } from "lucide-react-native";
import { StyleSheet, View } from "react-native";
import Animated, { Extrapolation, interpolate, useAnimatedStyle } from "react-native-reanimated";
import type { SharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Image } from "@/components/ui/image";
import { Text } from "@/components/ui/text";
import { artworkUrl } from "@/lib/artwork";
import { watchHref } from "@/lib/routes";
import { useThemeColor } from "@/lib/theme-color";
import { useServer } from "@/session/connection";

import { playAction, titleFacts } from "./title-model";
import { useMyListToggle } from "./use-title-actions";

/** The artwork's height, which the parallax and stretch are measured against. */
const HERO_HEIGHT = 480;

/** Scroll offsets over which the top bar turns compact: the title passing under it. */
const COMPACT_FROM = 150;

const COMPACT_TO = 200;

/** The artwork behind the header, moving with `scrollY`. */
function HeroArtwork({
  uri,
  scrollY,
}: {
  readonly uri: string | undefined;
  readonly scrollY: SharedValue<number>;
}) {
  const scrim = useThemeColor("--color-scrim");
  const page = useThemeColor("--color-bg");

  const motion = useAnimatedStyle(() => {
    const y = scrollY.value;

    // Pulled down, the artwork grows from its top edge; scrolled up, it drifts at half speed.
    return y < 0
      ? { opacity: 1, transform: [{ translateY: y / 2 }, { scale: 1 - y / HERO_HEIGHT }] }
      : {
          opacity: interpolate(y, [0, HERO_HEIGHT], [1, 0], Extrapolation.CLAMP),
          transform: [{ translateY: y / 2 }, { scale: 1 }],
        };
  });

  return (
    <Animated.View
      className="absolute inset-x-0 top-0 h-120 bg-surface"
      style={motion}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {uri === undefined ? null : (
        <Image source={{ uri }} contentFit="cover" transition={200} className="size-full" />
      )}
      <LinearGradient
        colors={[scrim, "transparent", page]}
        locations={[0, 0.3, 1]}
        style={StyleSheet.absoluteFill}
      />
    </Animated.View>
  );
}

/** Props for `TitleHero`. */
export interface TitleHeroProps {
  readonly title: TitleDetail;
  readonly profileId: ProfileId;
  readonly scrollY: SharedValue<number>;
}

/** The artwork, the title, its facts, the play row, and the overview. */
export function TitleHero({ title, profileId, scrollY }: TitleHeroProps) {
  const insets = useSafeAreaInsets();
  const { mediaUrl } = useServer();
  const backdrop = artworkUrl(mediaUrl, title.artwork.backdrop ?? title.artwork.poster, "backdrop");
  const logo = artworkUrl(mediaUrl, title.artwork.logo, "card");
  const play = playAction(title);
  const myList = useMyListToggle(profileId, title.id, title.inMyList);

  return (
    <View>
      <HeroArtwork uri={backdrop} scrollY={scrollY} />
      <View style={{ height: insets.top }} />
      <View className="gap-3 px-5 pt-56 pb-1">
        {logo === undefined ? (
          <Text variant="largeTitle" className="text-center" accessibilityRole="header">
            {title.name}
          </Text>
        ) : (
          <Image
            source={{ uri: logo }}
            contentFit="contain"
            className="h-20 w-full"
            accessible
            accessibilityRole="header"
            accessibilityLabel={title.name}
          />
        )}
        <Text variant="metaStrong" className="text-center">
          {titleFacts(title)}
        </Text>
        <View className="flex-row items-center gap-3">
          <Button
            label={play.label}
            icon={Play}
            iconFilled
            className="flex-1"
            disabled={!play.available}
            onPress={() => router.push(watchHref({ titleId: title.id, episodeId: play.episodeId }))}
          />
          <IconButton
            icon={myList.inList ? Check : Plus}
            label={myList.inList ? "Remove from My List" : "Add to My List"}
            variant="glass"
            size="control"
            onPress={() => void myList.toggle()}
          />
        </View>
        {myList.error === null ? null : (
          <Text variant="meta" tone="danger" accessibilityLiveRegion="polite">
            {myList.error}
          </Text>
        )}
        {title.overview === null ? null : <Text numberOfLines={4}>{title.overview}</Text>}
      </View>
    </View>
  );
}

/** Props for `TitleTopBar`. */
export interface TitleTopBarProps {
  readonly name: string;
  readonly scrollY: SharedValue<number>;
  readonly onMore: () => void;
}

/** Back and More over the artwork, gaining a glass bar and the title once scrolled. */
export function TitleTopBar({ name, scrollY, onMore }: TitleTopBarProps) {
  const insets = useSafeAreaInsets();

  const compact = useAnimatedStyle(() => ({
    opacity: interpolate(scrollY.value, [COMPACT_FROM, COMPACT_TO], [0, 1], Extrapolation.CLAMP),
  }));

  return (
    <View
      className="absolute inset-x-0 top-0"
      style={{ paddingTop: insets.top }}
      pointerEvents="box-none"
    >
      <Animated.View style={[StyleSheet.absoluteFill, compact]} pointerEvents="none">
        <BlurView tint="systemChromeMaterial" intensity={100} style={StyleSheet.absoluteFill} />
        <View className="absolute inset-0 bg-bg/60" />
      </Animated.View>
      <View className="h-16 flex-row items-center gap-3 px-5" pointerEvents="box-none">
        <IconButton
          icon={ChevronLeft}
          label="Back"
          variant="glass"
          onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))}
        />
        <Animated.View style={compact} className="flex-1" pointerEvents="none">
          <Text variant="navTitle" numberOfLines={1} accessibilityElementsHidden>
            {name}
          </Text>
        </Animated.View>
        <IconButton icon={Ellipsis} label="More" variant="glass" onPress={onMore} />
      </View>
    </View>
  );
}
