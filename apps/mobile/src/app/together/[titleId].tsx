/**
 * G01 · Watch Together, from a title's page: what the room will play, then Start Room, which opens
 * the room (G02) to invite people before anyone presses play. A movie starts where the profile
 * stopped; a show at its next episode, or at the episode its actions (D07) were opened on.
 */
import type { EpisodeId, TitleId } from "@movies/contracts/ids";
import type { Episode, TitleDetail } from "@movies/contracts/models/catalog";
import { Milliseconds } from "@movies/contracts/units";
import { useCommand, useCommandQuery } from "@movies/sdk/react";
import * as Haptics from "expo-haptics";
import { router, useLocalSearchParams } from "expo-router";
import { CircleAlert, UsersRound } from "lucide-react-native";
import { useState } from "react";
import { ActivityIndicator, ScrollView, View } from "react-native";

import { RoomArtwork } from "@/components/rooms/room-parts";
import { episodeIdParam, seasonParam, titleIdParam } from "@/components/title/route-params";
import { Button } from "@/components/ui/button";
import { CalmState } from "@/components/ui/calm-state";
import { NavHeader } from "@/components/ui/nav-header";
import { Screen } from "@/components/ui/screen";
import { Text } from "@/components/ui/text";
import { artworkUrl } from "@/lib/artwork";
import { deviceId } from "@/lib/device";
import { describeFailure } from "@/lib/failure";
import { episodeLine } from "@/lib/player/next-episode";
import { roomStart } from "@/lib/rooms/room-start";
import { useActiveProfile } from "@/session/active-profile";
import { useServer } from "@/session/connection";

/** The start screen for a loaded title, playing `chosen` when an episode was picked. */
function StartRoom({
  title,
  chosen,
}: {
  readonly title: TitleDetail;
  readonly chosen: Episode | null;
}) {
  const { profile } = useActiveProfile();
  const { mediaUrl } = useServer();
  const create = useCommand("rooms.create");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = roomStart(title, chosen);
  const { episode } = start;

  const startRoom = () => {
    setBusy(true);
    setError(null);

    const input = {
      profileId: profile.id,
      deviceId: deviceId(),
      titleId: title.id,
      positionMs: Milliseconds.make(start.positionMs),
    };

    void create(start.episodeId === undefined ? input : { ...input, episodeId: start.episodeId })
      .then((room) => {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        router.replace(`/room/${room.id}`);

        return undefined;
      })
      .catch((cause: unknown) => {
        setBusy(false);
        setError(describeFailure(cause));
      });
  };

  return (
    <ScrollView contentContainerClassName="gap-4 px-5 py-4">
      <RoomArtwork
        uri={artworkUrl(
          mediaUrl,
          episode?.still ?? title.artwork.backdrop ?? title.artwork.poster,
          "backdrop",
        )}
      />
      <View className="gap-1">
        <Text variant="title" accessibilityRole="header">
          {title.name}
        </Text>
        {episode === null ? null : (
          <Text variant="secondary" tone="muted">
            {episodeLine(episode)}
          </Text>
        )}
      </View>
      <Text tone="muted">Invite people from your household.</Text>
      <View className="h-8" />
      {error === null ? null : (
        <Text variant="meta" tone="danger" accessibilityLiveRegion="polite">
          {error}
        </Text>
      )}
      <Button label="Start Room" icon={UsersRound} busy={busy} onPress={startRoom} />
    </ScrollView>
  );
}

/** The episode picked on D07, from its season, which the show's page has already subscribed to. */
const useChosenEpisode = (
  titleId: TitleId | null,
  episodeId: EpisodeId | null,
  seasonNumber: number | null,
) => {
  const { profile } = useActiveProfile();

  const episodes = useCommandQuery(
    "titles.episodes",
    titleId === null || episodeId === null || seasonNumber === null
      ? "skip"
      : { profileId: profile.id, titleId, seasonNumber },
  );

  if (episodeId === null) return { status: "none" } as const;

  if (episodes.status !== "success") return episodes;

  const episode = episodes.data.find((candidate) => candidate.id === episodeId);

  return { status: "success", data: episode ?? null } as const;
};

export default function WatchTogether() {
  const params = useLocalSearchParams<{ titleId: string; episodeId?: string; season?: string }>();
  const titleId = titleIdParam(params.titleId);
  const { profile } = useActiveProfile();

  const chosen = useChosenEpisode(
    titleId,
    episodeIdParam(params.episodeId),
    seasonParam(params.season),
  );

  const title = useCommandQuery(
    "titles.get",
    titleId === null ? "skip" : { profileId: profile.id, titleId },
  );

  const failure = title.status === "error" ? title : chosen.status === "error" ? chosen : null;

  return (
    <Screen header={<NavHeader title="Watch Together" />}>
      {title.status === "success" && (chosen.status === "success" || chosen.status === "none") ? (
        <StartRoom title={title.data} chosen={chosen.status === "success" ? chosen.data : null} />
      ) : failure !== null ? (
        <CalmState
          icon={CircleAlert}
          title="Couldn’t Load This Title"
          description={describeFailure(failure.error)}
          actions={<Button label="Try Again" onPress={failure.retry} />}
        />
      ) : titleId === null ? (
        <CalmState icon={CircleAlert} title="Title Not Found" />
      ) : (
        <ActivityIndicator className="flex-1" colorClassName="accent-text-muted" />
      )}
    </Screen>
  );
}
