/**
 * The player's Episodes panel: the show's seasons and episodes over the video, opening on the
 * episode playing. Choosing another episode plays it in the player; the seasons and episodes are
 * the ones the title page lists, so they are only those the profile may see.
 */
import type { EpisodeId, ProfileId, TitleId } from "@movies/contracts/ids";
import type { SeasonEpisode, TitleDetail } from "@movies/contracts/models/catalog";
import { useCommandQuery } from "@movies/sdk/react";
import { EpisodePopover } from "@movies/ui/components/episode-popover";
import type { EpisodeOption, SeasonOption } from "@movies/ui/components/episode-popover";
import { useMemo, useState } from "react";
import type { ReactElement } from "react";

import { artworkUrl } from "@/lib/artwork";
import { episodeRuntimeFacts, progressFraction } from "@/lib/format";

/** `24m · 12m left`, or `File missing` for an episode with nothing on disk. */
const episodeDetail = (episode: SeasonEpisode): string | undefined => {
  const parts = episodeRuntimeFacts(episode);

  return parts === "" ? undefined : parts;
};

const episodeOption = (episode: SeasonEpisode): EpisodeOption => ({
  id: episode.id,
  episodeNumber: episode.episodeNumber,
  title: episode.name,
  detail: episodeDetail(episode),
  image: artworkUrl(episode.still, "card"),
  progress: progressFraction(episode.progress) ?? undefined,
  available: episode.available,
});

/**
 * The Episodes popover on `trigger`.
 *
 * @param current - The episode playing; the panel opens on its season, with it marked.
 * @param currentSeason - The episodes of the season playing, which the player already has; null
 *   while they load. Only other seasons are fetched here.
 * @param onPlay - Plays another episode; choosing the one playing only closes the panel.
 */
export function EpisodePicker({
  trigger,
  container,
  open,
  onOpenChange,
  profileId,
  titleId,
  seasons,
  current,
  currentSeason,
  onPlay,
}: {
  readonly trigger: ReactElement;
  readonly container: HTMLElement | undefined;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly profileId: ProfileId;
  readonly titleId: TitleId;
  readonly seasons: TitleDetail["seasons"];
  readonly current: { readonly id: EpisodeId; readonly seasonNumber: number };
  readonly currentSeason: ReadonlyArray<SeasonEpisode> | null;
  readonly onPlay: (episodeId: EpisodeId) => void;
}) {
  // The season browsed to, until the panel closes; it opens on the current episode's again.
  const [browsing, setBrowsing] = useState<number | null>(null);
  const seasonNumber = browsing ?? current.seasonNumber;

  const browsingOther = seasonNumber !== current.seasonNumber;

  const other = useCommandQuery(
    "titles.episodes",
    open && browsingOther ? { profileId, titleId, seasonNumber } : "skip",
  );

  const loaded = browsingOther ? (other.status === "success" ? other.data : null) : currentSeason;
  const failed = browsingOther && other.status === "error";

  // A season that cannot load lists nothing rather than loading forever.
  const episodes = useMemo(
    () => (failed ? [] : (loaded?.map(episodeOption) ?? null)),
    [failed, loaded],
  );

  const seasonOptions = useMemo(
    (): ReadonlyArray<SeasonOption> =>
      seasons.map((season) => ({ seasonNumber: season.seasonNumber, name: season.name })),
    [seasons],
  );

  const changeOpen = (next: boolean): void => {
    if (!next) setBrowsing(null);
    onOpenChange(next);
  };

  return (
    <EpisodePopover
      trigger={trigger}
      container={container}
      open={open}
      onOpenChange={changeOpen}
      seasons={seasonOptions}
      seasonNumber={seasonNumber}
      onSeasonChange={setBrowsing}
      episodes={episodes}
      currentId={current.id}
      onSelect={(option) => {
        const chosen = loaded?.find((episode) => episode.id === option.id);

        changeOpen(false);

        if (chosen !== undefined && chosen.id !== current.id) onPlay(chosen.id);
      }}
    />
  );
}
