import type { TitleCard } from "@movies/contracts/models/catalog";
import { useCommandQuery } from "@movies/sdk/react";
import { router } from "expo-router";
import { LinearGradient } from "expo-linear-gradient";
import { Check, Play, Plus } from "lucide-react-native";
import { useState } from "react";
import type { ReactNode } from "react";
import { FlatList, Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import { useUniwind } from "uniwind";

import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Image } from "@/components/ui/image";
import { Text } from "@/components/ui/text";
import { artworkUrl } from "@/lib/artwork";
import { heroFacts, playTarget } from "@/lib/browse";
import { watchHref } from "@/lib/routes";
import { useThemeColor } from "@/lib/theme-color";
import { useActiveProfile } from "@/session/active-profile";
import { useServer } from "@/session/connection";

import { useTitleStates } from "./title-states";

/** Props for `Hero`. */
export interface HeroProps {
  /** The titles to page through, featured first. */
  readonly titles: ReadonlyArray<TitleCard>;
  /** The large title and filters drawn over the top of the artwork. */
  readonly header?: ReactNode;
}

const DARK_SCRIM_LOCATIONS = [0, 0.3, 0.96] as const;

const LIGHT_SCRIM_LOCATIONS = [0, 0.28, 0.8, 1] as const;

function HeroPage({ title, width }: { readonly title: TitleCard; readonly width: number }) {
  const { mediaUrl } = useServer();
  const backdrop = artworkUrl(mediaUrl, title.artwork.backdrop ?? title.artwork.poster, "backdrop");
  const logo = artworkUrl(mediaUrl, title.artwork.logo, "card");
  const scrim = useThemeColor("--color-scrim");
  const page = useThemeColor("--color-bg");
  const light = useUniwind().theme === "light";

  return (
    <View style={{ width }} className="h-full justify-end">
      {backdrop === undefined ? null : (
        <Image
          source={{ uri: backdrop }}
          contentFit="cover"
          contentPosition="top"
          transition={200}
          className="absolute inset-0"
          accessibilityIgnoresInvertColors
        />
      )}
      <LinearGradient
        colors={light ? [scrim, "transparent", scrim, page] : [scrim, "transparent", page]}
        locations={light ? LIGHT_SCRIM_LOCATIONS : DARK_SCRIM_LOCATIONS}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={title.name}
        accessibilityHint="Opens the title."
        onPress={() => router.push(`/title/${title.id}`)}
        className="items-center px-5 pb-37 active:opacity-80"
      >
        {logo === undefined ? (
          <Text
            variant="heroTitle"
            tone="onMedia"
            className="text-center"
            numberOfLines={2}
            adjustsFontSizeToFit
          >
            {title.name}
          </Text>
        ) : (
          <Image source={{ uri: logo }} contentFit="contain" className="h-20 w-70" />
        )}
      </Pressable>
    </View>
  );
}

/** The paging billboard. */
export function Hero({ titles, header }: HeroProps) {
  const { width } = useWindowDimensions();
  const pagesKey = titles.map((title) => title.id).join();
  const [paging, setPaging] = useState({ pagesKey, index: 0 });
  const index = paging.pagesKey === pagesKey ? Math.min(paging.index, titles.length - 1) : 0;
  const current = titles[index];

  if (current === undefined) return null;

  return (
    <View className="h-146 bg-bg">
      <FlatList
        key={pagesKey}
        horizontal
        pagingEnabled
        data={titles}
        keyExtractor={(title) => title.id}
        renderItem={({ item }) => <HeroPage title={item} width={width} />}
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={(event) =>
          setPaging({ pagesKey, index: Math.round(event.nativeEvent.contentOffset.x / width) })
        }
        className="absolute inset-0"
        accessibilityRole="adjustable"
      />
      <View className="absolute inset-x-0 top-0" pointerEvents="box-none">
        {header}
      </View>
      <HeroDetails title={current} pages={titles.length} index={index} />
    </View>
  );
}

function HeroDetails({
  title,
  pages,
  index,
}: {
  readonly title: TitleCard;
  readonly pages: number;
  readonly index: number;
}) {
  const { profile } = useActiveProfile();
  const states = useTitleStates();
  const detail = useCommandQuery("titles.get", { profileId: profile.id, titleId: title.id });
  const loaded = detail.status === "success" ? detail.data : null;
  const play = playTarget(title.id, loaded);
  const inList = states.inMyList(title.id);

  return (
    <View className="absolute inset-x-0 bottom-0 gap-4 px-5 pb-4" pointerEvents="box-none">
      <Text variant="metaStrong" tone="onMedia" className="text-center" numberOfLines={1}>
        {heroFacts(title, loaded?.seasons.length ?? null)}
      </Text>
      <View className="flex-row items-center gap-3 px-12">
        {title.available ? (
          <Button
            label={play.label}
            icon={Play}
            iconFilled
            className="flex-1"
            onPress={() => router.push(play.href)}
          />
        ) : (
          <Button
            label="More Info"
            className="flex-1"
            onPress={() => router.push(`/title/${title.id}`)}
          />
        )}
        <IconButton
          icon={inList ? Check : Plus}
          label={inList ? `Remove ${title.name} from My List` : `Add ${title.name} to My List`}
          variant="glass"
          size="large"
          onPress={() => void (inList ? states.removeFromMyList(title) : states.addToMyList(title))}
        />
      </View>
      {pages < 2 ? (
        <View className="h-3" />
      ) : (
        <View
          className="h-3 flex-row items-center justify-center gap-1.5"
          accessibilityLabel={`Page ${index + 1} of ${pages}`}
        >
          {Array.from({ length: pages }, (_, page) => (
            <View
              key={page}
              className={
                page === index
                  ? "h-1.5 w-5 rounded-pill bg-text"
                  : "size-1.5 rounded-pill bg-text-muted"
              }
            />
          ))}
        </View>
      )}
    </View>
  );
}

/** The Kids billboard (C10): an inset card, the name, and Play. */
export function KidsHero({ title }: { readonly title: TitleCard }) {
  const { mediaUrl } = useServer();
  const backdrop = artworkUrl(mediaUrl, title.artwork.backdrop ?? title.artwork.poster, "backdrop");

  return (
    <View className="gap-4 px-5">
      <View className="h-56 overflow-hidden rounded-card bg-surface-raised">
        {backdrop === undefined ? null : (
          <Image
            source={{ uri: backdrop }}
            contentFit="cover"
            transition={200}
            className="size-full"
          />
        )}
      </View>
      <Text variant="title" numberOfLines={2}>
        {title.name}
      </Text>
      {title.available ? (
        <Button
          label="Play"
          icon={Play}
          iconFilled
          onPress={() => router.push(watchHref({ titleId: title.id }))}
        />
      ) : null}
    </View>
  );
}
