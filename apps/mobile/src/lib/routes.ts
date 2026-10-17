/**
 * Links into the player, written one way so every screen that starts playback and the player that
 * reads them agree: `/watch/<titleId>?episodeId=<id>&fileId=<id>&start=beginning`.
 */
import type { EpisodeId, MediaFileId, TitleId } from "@movies/contracts/ids";

/** What to play: a movie, or a show's episode, in a chosen version, and from where. */
export interface WatchTarget {
  readonly titleId: TitleId;
  /** The episode of a show; omit for a movie, or to let the player choose a show's next one. */
  readonly episodeId?: EpisodeId | undefined;
  /** A version from `titles.versions`; omit to let the server choose. */
  readonly fileId?: MediaFileId | undefined;
  /** `beginning` for Start Over; omit to resume from the saved progress. */
  readonly start?: "beginning" | undefined;
}

/**
 * The player's href for `target`. Present parameters appear in the order `episodeId`, `fileId`,
 * `start`, each URI-encoded, so `new URLSearchParams(query)` reads back the same values.
 */
export const watchHref = ({ titleId, episodeId, fileId, start }: WatchTarget): string => {
  const query = (
    [
      ["episodeId", episodeId],
      ["fileId", fileId],
      ["start", start],
    ] as const
  )
    .flatMap(([key, value]) => (value === undefined ? [] : [`${key}=${encodeURIComponent(value)}`]))
    .join("&");

  const path = `/watch/${encodeURIComponent(titleId)}`;

  return query === "" ? path : `${path}?${query}`;
};
