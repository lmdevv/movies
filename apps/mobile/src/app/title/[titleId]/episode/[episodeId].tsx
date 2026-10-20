/**
 * D07 · Episode Actions: play it from the beginning once it has progress, mark it watched or
 * unwatched, watch it together, and choose among its versions when it has several. Tapping the
 * episode itself already plays or resumes it, so the sheet has no Play row.
 */
import type { EpisodeId, TitleId } from "@movies/contracts/ids";
import type { SeasonEpisode } from "@movies/contracts/models/catalog";
import { useCommand, useCommandQuery } from "@movies/sdk/react";
import { useLocalSearchParams } from "expo-router";
import { Check, Clapperboard, EyeOff, RotateCcw, UsersRound } from "lucide-react-native";

import { episodeIdParam, seasonParam, titleIdParam } from "@/components/title/route-params";
import { Sheet, useSheetExit } from "@/components/title/sheet";
import { episodeSubtitle, resumeOf } from "@/components/title/title-model";
import { useRunner } from "@/components/title/use-title-actions";
import { ListRow } from "@/components/ui/list-row";
import { describeFailure } from "@/lib/failure";
import { watchHref } from "@/lib/routes";
import { useActiveProfile } from "@/session/active-profile";

/** The actions of one loaded episode. */
function EpisodeActions({ episode }: { readonly episode: SeasonEpisode }) {
  const { profile } = useActiveProfile();
  const markWatched = useCommand("history.markWatched");
  const markUnwatched = useCommand("history.markUnwatched");
  const mark = useRunner();
  const exit = useSheetExit();
  const resume = resumeOf(episode.progress);
  const watched = episode.progress?.watched === true;
  const target = { titleId: episode.titleId, episodeId: episode.id };

  const versions = useCommandQuery("titles.versions", {
    profileId: profile.id,
    titleId: episode.titleId,
    episodeId: episode.id,
  });

  const toggleWatched = async () => {
    const args = { profileId: profile.id, ...target };
    const done = await mark.run(() => (watched ? markUnwatched(args) : markWatched(args)));

    if (done) exit.close();
  };

  return (
    <Sheet title={episode.name} subtitle={episodeSubtitle(episode)} error={mark.error} exit={exit}>
      {resume === null ? null : (
        <ListRow
          icon={RotateCcw}
          title="Play from Beginning"
          disabled={!episode.available}
          onPress={() => exit.leaveFor(watchHref({ ...target, start: "beginning" }))}
        />
      )}
      <ListRow
        icon={watched ? EyeOff : Check}
        title={watched ? "Mark as Unwatched" : "Mark as Watched"}
        disabled={mark.busy}
        onPress={() => void toggleWatched()}
      />
      <ListRow
        icon={UsersRound}
        title="Watch Together"
        disabled={!episode.available}
        onPress={() =>
          exit.leaveFor(
            `/together/${episode.titleId}?episodeId=${episode.id}&season=${String(episode.seasonNumber)}`,
          )
        }
      />
      {versions.status === "success" && versions.data.length > 1 ? (
        <ListRow
          icon={Clapperboard}
          title="Choose Version"
          detail={`${versions.data.length} versions`}
          onPress={() =>
            exit.switchTo(`/title/${episode.titleId}/versions?episodeId=${episode.id}`)
          }
        />
      ) : null}
    </Sheet>
  );
}

/** Loads the episode from its season, which the show's page has already subscribed to. */
function EpisodeLoader({
  titleId,
  episodeId,
  seasonNumber,
}: {
  readonly titleId: TitleId;
  readonly episodeId: EpisodeId;
  readonly seasonNumber: number;
}) {
  const { profile } = useActiveProfile();

  const episodes = useCommandQuery("titles.episodes", {
    profileId: profile.id,
    titleId,
    seasonNumber,
  });

  if (episodes.status !== "success") {
    return (
      <Sheet
        title="Episode"
        loading={episodes.status === "loading"}
        error={episodes.status === "error" ? describeFailure(episodes.error) : null}
      />
    );
  }

  const episode = episodes.data.find((candidate) => candidate.id === episodeId);

  return episode === undefined ? (
    <Sheet title="Episode" error="This episode isn't here." />
  ) : (
    <EpisodeActions episode={episode} />
  );
}

export default function EpisodeActionsSheet() {
  const params = useLocalSearchParams<{ titleId: string; episodeId: string; season?: string }>();
  const titleId = titleIdParam(params.titleId);
  const episodeId = episodeIdParam(params.episodeId);
  const seasonNumber = seasonParam(params.season);

  if (titleId === null || episodeId === null || seasonNumber === null) {
    return <Sheet title="Episode" error="This episode isn't here." />;
  }

  return <EpisodeLoader titleId={titleId} episodeId={episodeId} seasonNumber={seasonNumber} />;
}
