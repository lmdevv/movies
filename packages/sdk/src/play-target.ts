/**
 * What the main button of a title does, for every client's title page and billboard: start,
 * resume, or play a show's next episode, with the label Paper writes for it.
 */
import type { EpisodeId } from "@movies/contracts/ids";
import type { TitleDetail } from "@movies/contracts/models/catalog";

import { episodeCode, progressFraction } from "./format";

/** What the main button of a title does: start, resume, or play the next episode. */
export interface PlayTarget {
  /** `Play`, `Resume`, `Resume S2:E4`, or `Play S1:E1`. */
  readonly label: string;
  readonly resuming: boolean;
  /** The episode to play, for shows. */
  readonly episodeId: EpisodeId | undefined;
  /** Fraction watched of what the button resumes, when it resumes. */
  readonly fraction: number | null;
  /** Where it resumes, in milliseconds. */
  readonly positionMs: number | null;
}

/** The main play action of a title page or billboard. */
export const playTarget = (title: TitleDetail): PlayTarget => {
  if (title.kind === "movie") {
    const fraction = title.progress?.watched === true ? null : progressFraction(title.progress);

    return {
      label: fraction === null ? "Play" : "Resume",
      resuming: fraction !== null,
      episodeId: undefined,
      fraction,
      positionMs: fraction === null ? null : (title.progress?.positionMs ?? null),
    };
  }

  const next = title.nextEpisode;

  if (next === null) {
    return {
      label: "Play",
      resuming: false,
      episodeId: undefined,
      fraction: null,
      positionMs: null,
    };
  }

  const fraction = next.progress?.watched === true ? null : progressFraction(next.progress);

  return {
    label: `${fraction === null ? "Play" : "Resume"} ${episodeCode(next)}`,
    resuming: fraction !== null,
    episodeId: next.id,
    fraction,
    positionMs: fraction === null ? null : (next.progress?.positionMs ?? null),
  };
};
