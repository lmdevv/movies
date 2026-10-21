/**
 * The player's Episodes panel: the show's seasons and episodes over the video, opening on the
 * episode playing. Choosing another episode plays it in the player; the seasons and episodes are
 * the ones the title page lists, so they are only those the profile may see.
 */
import type { EpisodeId, ProfileId, TitleId } from "@movies/contracts/ids";
import type { SeasonEpisode, TitleDetail } from "@movies/contracts/models/catalog";
import { useCommandQuery } from "@movies/sdk/react";
import { EpisodePopover } from "@movies/ui/components/episode-popover";
import type { EpisodeOption } from "@movies/ui/components/episode-popover";
import { useMemo, useState } from "react";
import type { ReactElement } from "react";

import { artworkUrl } from "@/lib/artwork";
import { episodeRuntimeFacts, progressFraction } from "@/lib/format";
import { listOrLoading } from "@/lib/query-state";

/** `24m · 12m left` or `24m · File missing`; undefined when there is nothing to say. */
const episodeDetail = (episode: SeasonEpisode): string | undefined => {
  const parts = episodeRuntimeFacts(episode);

  return parts === "" ? undefined : parts;
};

const episodeOption = (episode: SeasonEpisode): EpisodeOption<EpisodeId> => ({
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
 *   while they load, empty if they could not. Only other seasons are fetched here.
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
  // The season browsed to, until the panel has closed; it opens on the current episode's again.
  const [browsing, setBrowsing] = useState<number | null>(null);
  const seasonNumber = browsing ?? current.seasonNumber;

  const browsingOther = seasonNumber !== current.seasonNumber;

  const other = useCommandQuery(
    "titles.episodes",
    browsingOther ? { profileId, titleId, seasonNumber } : "skip",
  );

  const loaded = browsingOther ? listOrLoading(other) : currentSeason;
  const episodes = useMemo(() => loaded?.map(episodeOption) ?? null, [loaded]);

  return (
    <EpisodePopover
      trigger={trigger}
      container={container}
      open={open}
      onOpenChange={onOpenChange}
      onClosed={() => setBrowsing(null)}
      seasons={seasons}
      seasonNumber={seasonNumber}
      onSeasonChange={setBrowsing}
      episodes={episodes}
      currentId={current.id}
      onSelect={(option) => {
        onOpenChange(false);

        if (option.id !== current.id) onPlay(option.id);
      }}
    />
  );
}
