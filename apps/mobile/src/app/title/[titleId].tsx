/**
 * D01–D04 · A movie's or show's page, live: the artwork header, Play or Resume, My List, the
 * overview, a show's season and episodes, About, Cast & Crew, a movie's versions, and More Like
 * This. D08 replaces it while none of the title's files is on disk.
 */
import type { ProfileId, TitleId } from "@movies/contracts/ids";
import type { SeasonEpisode, TitleDetail } from "@movies/contracts/models/catalog";
import { useCommandQuery } from "@movies/sdk/react";
import { router, useLocalSearchParams } from "expo-router";
import { ChevronDown, CircleAlert } from "lucide-react-native";
import { ActivityIndicator, Pressable, View } from "react-native";
import Animated, { useAnimatedScrollHandler, useSharedValue } from "react-native-reanimated";

import { EpisodeRow } from "@/components/title/episode-row";
import { FileUnavailable } from "@/components/title/file-unavailable";
import { seasonParam, titleIdParam } from "@/components/title/route-params";
import { TitleHero, TitleTopBar } from "@/components/title/title-hero";
import { initialSeason } from "@/components/title/title-model";
import {
  AboutRow,
  AvailableVersions,
  CastAndCrew,
  MoreLikeThis,
} from "@/components/title/title-sections";
import { Button } from "@/components/ui/button";
import { CalmState } from "@/components/ui/calm-state";
import { Icon } from "@/components/ui/icon";
import { NavHeader } from "@/components/ui/nav-header";
import { Screen } from "@/components/ui/screen";
import { Text } from "@/components/ui/text";
import { describeFailure, isFailure } from "@/lib/failure";
import { useActiveProfile } from "@/session/active-profile";

const NO_EPISODES: ReadonlyArray<SeasonEpisode> = [];

/** The season heading; with several seasons it opens the season picker (D05). */
function SeasonHeading({
  title,
  seasonNumber,
}: {
  readonly title: TitleDetail;
  readonly seasonNumber: number;
}) {
  const season = title.seasons.find((candidate) => candidate.seasonNumber === seasonNumber);
  const name = season?.name ?? `Season ${seasonNumber}`;

  if (title.seasons.length < 2) {
    return (
      <Text variant="heading" className="px-5" accessibilityRole="header">
        {name}
      </Text>
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${name}, choose season`}
      onPress={() => router.push(`/title/${title.id}/seasons?season=${seasonNumber}`)}
      className="flex-row items-center gap-2 self-start px-5 active:opacity-60"
    >
      <Text variant="heading">{name}</Text>
      <Icon icon={ChevronDown} size="inline" />
    </Pressable>
  );
}

/** The live page of an available title. */
function TitleDetailView({
  title,
  profileId,
}: {
  readonly title: TitleDetail;
  readonly profileId: ProfileId;
}) {
  const params = useLocalSearchParams<{ season?: string }>();
  const scrollY = useSharedValue(0);

  const onScroll = useAnimatedScrollHandler((event) => {
    scrollY.value = event.contentOffset.y;
  });

  const seasonNumber = seasonParam(params.season) ?? initialSeason(title);
  const show = title.kind === "show";

  const episodes = useCommandQuery(
    "titles.episodes",
    show && seasonNumber !== null ? { profileId, titleId: title.id, seasonNumber } : "skip",
  );

  return (
    <View className="flex-1 bg-bg">
      <Animated.FlatList
        data={episodes.status === "success" ? episodes.data : NO_EPISODES}
        keyExtractor={(episode) => episode.id}
        renderItem={({ item }) => <EpisodeRow episode={item} />}
        ItemSeparatorComponent={EpisodeGap}
        onScroll={onScroll}
        scrollEventThrottle={16}
        contentInsetAdjustmentBehavior="never"
        contentContainerClassName="pb-16"
        ListHeaderComponent={
          <View className="gap-4 pb-4">
            <TitleHero title={title} profileId={profileId} scrollY={scrollY} />
            {show ? null : (
              <View className="px-5">
                <AboutRow title={title} />
              </View>
            )}
            {show && seasonNumber !== null ? (
              <SeasonHeading title={title} seasonNumber={seasonNumber} />
            ) : null}
            {show && episodes.status === "loading" ? (
              <ActivityIndicator className="py-6" colorClassName="accent-text-muted" />
            ) : null}
            {episodes.status === "error" ? (
              <View className="items-start gap-2 px-5">
                <Text variant="meta" tone="danger">
                  {describeFailure(episodes.error)}
                </Text>
                <Button label="Try Again" variant="secondary" onPress={episodes.retry} />
              </View>
            ) : null}
          </View>
        }
        ListFooterComponent={
          <View className="gap-6 pt-2">
            <View className="gap-6 px-5">
              {show ? <AboutRow title={title} /> : null}
              <CastAndCrew title={title} />
              <AvailableVersions title={title} />
            </View>
            <MoreLikeThis profileId={profileId} titleId={title.id} />
          </View>
        }
      />
      <TitleTopBar
        name={title.name}
        scrollY={scrollY}
        onMore={() => router.push(`/title/${title.id}/actions`)}
      />
    </View>
  );
}

/** The 16pt gap between episode rows. */
function EpisodeGap() {
  return <View className="h-4" />;
}

/** A title, loaded live, with its loading and failure states. */
function TitleLoader({ titleId }: { readonly titleId: TitleId }) {
  const { profile } = useActiveProfile();
  const title = useCommandQuery("titles.get", { profileId: profile.id, titleId });

  if (title.status === "loading") {
    return (
      <Screen edges={["top"]} header={<NavHeader />}>
        <ActivityIndicator className="flex-1" colorClassName="accent-text-muted" />
      </Screen>
    );
  }

  if (title.status === "error") {
    const missing = isFailure(title.error, "NotFound");

    return (
      <Screen header={<NavHeader />}>
        <CalmState
          icon={CircleAlert}
          title={missing ? "Title Not Found" : "Couldn't Load This Title"}
          {...(missing
            ? {}
            : {
                description: describeFailure(title.error),
                actions: <Button label="Try Again" onPress={title.retry} />,
              })}
        />
      </Screen>
    );
  }

  return title.data.available ? (
    <TitleDetailView title={title.data} profileId={profile.id} />
  ) : (
    <FileUnavailable title={title.data} />
  );
}

export default function TitleScreen() {
  const params = useLocalSearchParams<{ titleId: string }>();
  const titleId = titleIdParam(params.titleId);

  if (titleId === null) {
    return (
      <Screen header={<NavHeader />}>
        <CalmState icon={CircleAlert} title="Title Not Found" />
      </Screen>
    );
  }

  return <TitleLoader key={titleId} titleId={titleId} />;
}
