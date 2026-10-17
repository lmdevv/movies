/** C01 · Home: the featured hero and the profile's rows. */
import type { TitleCard } from "@movies/contracts/models/catalog";
import { useCommandQuery } from "@movies/sdk/react";
import { router } from "expo-router";
import { Play } from "lucide-react-native";
import { FlatList, ScrollView, View } from "react-native";

import { ContinueCard } from "@/components/continue-card";
import { TitlePoster } from "@/components/title-poster";
import { Button } from "@/components/ui/button";
import { CalmState } from "@/components/ui/calm-state";
import { Image } from "@/components/ui/image";
import { Text } from "@/components/ui/text";
import { artworkUrl } from "@/lib/artwork";
import { describeFailure } from "@/lib/failure";
import { facts } from "@/lib/format";
import { useActiveProfile } from "@/session/active-profile";
import { useServer } from "@/session/connection";

function Rail({
  title,
  items,
}: {
  readonly title: string;
  readonly items: ReadonlyArray<TitleCard>;
}) {
  if (items.length === 0) return null;

  return (
    <View className="gap-3">
      <Text variant="heading" className="px-5" accessibilityRole="header">
        {title}
      </Text>
      <FlatList
        horizontal
        data={items}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <TitlePoster title={item} />}
        showsHorizontalScrollIndicator={false}
        contentContainerClassName="gap-2 px-5"
      />
    </View>
  );
}

export default function Home() {
  const { profile } = useActiveProfile();
  const { mediaUrl } = useServer();
  const home = useCommandQuery("titles.home", { profileId: profile.id });

  if (home.status === "loading") return <View className="flex-1 bg-bg" />;

  if (home.status === "error") {
    return (
      <View className="flex-1 bg-bg">
        <CalmState
          title="Couldn't Load Home"
          description={describeFailure(home.error)}
          actions={<Button label="Try Again" onPress={home.retry} />}
        />
      </View>
    );
  }

  const { featured } = home.data;

  const backdrop = artworkUrl(
    mediaUrl,
    featured?.artwork.backdrop ?? featured?.artwork.poster,
    "backdrop",
  );

  return (
    <ScrollView className="flex-1 bg-bg" contentContainerClassName="gap-8 pb-32">
      {featured === null ? null : (
        <View className="h-150 justify-end">
          {backdrop === undefined ? null : (
            <Image source={{ uri: backdrop }} contentFit="cover" className="absolute inset-0" />
          )}
          <View className="items-center gap-3 px-5 pb-6">
            <Text variant="display" tone="onMedia" className="text-center" numberOfLines={2}>
              {featured.name}
            </Text>
            <Text variant="metaStrong" tone="onMedia">
              {facts(featured.genres[0], featured.year, featured.certification)}
            </Text>
            <Button
              label="Play"
              icon={Play}
              iconFilled
              className="w-40"
              onPress={() => router.push(`/watch/${featured.id}`)}
            />
          </View>
        </View>
      )}
      {home.data.continueWatching.length === 0 ? null : (
        <View className="gap-3">
          <Text variant="heading" className="px-5" accessibilityRole="header">
            Continue Watching
          </Text>
          <FlatList
            horizontal
            data={home.data.continueWatching}
            keyExtractor={(item) => `${item.title.id}:${item.episode?.id ?? ""}`}
            renderItem={({ item }) => <ContinueCard item={item} />}
            showsHorizontalScrollIndicator={false}
            contentContainerClassName="gap-3 px-5"
          />
        </View>
      )}
      <Rail title="My List" items={home.data.myList} />
      <Rail title="Recently Added Movies" items={home.data.recentlyAddedMovies} />
      <Rail title="Recently Added Shows" items={home.data.recentlyAddedShows} />
    </ScrollView>
  );
}
