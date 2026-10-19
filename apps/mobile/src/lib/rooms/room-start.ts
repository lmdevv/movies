/**
 * What a room started from a title's page (G01) plays: a movie from where the profile stopped, or
 * the show's next episode from where the profile stopped in it, as Play on the page would.
 */
import type { EpisodeId } from "@movies/contracts/ids";
import type { Episode, Progress, TitleDetail } from "@movies/contracts/models/catalog";

/** The media and position a new room starts at. */
export interface RoomStart {
  /** The show's episode; undefined for a movie. */
  readonly episodeId: EpisodeId | undefined;
  readonly positionMs: number;
  /** The episode, for the line under the show's name. */
  readonly episode: Episode | null;
}

/** Where `progress` resumes: its position while unfinished, else the start. */
const resumeAt = (progress: Progress | null): number =>
  progress === null || progress.watched ? 0 : progress.positionMs;

/** The room `detail`'s page starts. */
export const roomStart = (
  detail: Pick<TitleDetail, "kind" | "progress" | "nextEpisode">,
): RoomStart => {
  if (detail.kind === "movie") {
    return { episodeId: undefined, positionMs: resumeAt(detail.progress), episode: null };
  }

  const next = detail.nextEpisode;

  return next === null
    ? { episodeId: undefined, positionMs: 0, episode: null }
    : { episodeId: next.id, positionMs: resumeAt(next.progress), episode: next };
};
