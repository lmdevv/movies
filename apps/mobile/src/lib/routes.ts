/**
 * Links into the player and what they carry: the title, an episode for shows, a chosen version
 * (file), and `start=beginning` to start over instead of resuming. Screens link with `watchHref`,
 * which writes them in one order; the player reads them back with `parseWatchParams`, which never
 * throws.
 */
import { EpisodeId, MediaFileId, TitleId } from "@movies/contracts/ids";
import { Schema } from "effect";
import type { Option } from "effect";

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

/** The player's params, as typed IDs. */
const WatchParams = Schema.Struct({
  titleId: TitleId,
  episodeId: Schema.optionalKey(EpisodeId),
  fileId: Schema.optionalKey(MediaFileId),
  start: Schema.optionalKey(Schema.Literal("beginning")),
});

/** What the player plays, read from its route. */
export interface WatchParams extends Schema.Schema.Type<typeof WatchParams> {}

const decodeWatchParams = Schema.decodeUnknownOption(WatchParams);

/** A route's params as Expo Router reads them: a repeated key gives an array. */
type RouteParams = Readonly<Record<string, string | string[] | undefined>>;

const KEYS = ["titleId", "episodeId", "fileId", "start"] as const;

/**
 * The player's params from Expo Router's `useLocalSearchParams()`, or none when the title is
 * missing or a value is malformed. Empty values count as absent; of a repeated key, the first.
 */
export const parseWatchParams = (params: RouteParams): Option.Option<WatchParams> =>
  decodeWatchParams(
    Object.fromEntries(
      KEYS.flatMap((key) => {
        const raw = params[key];
        const value = Array.isArray(raw) ? raw[0] : raw;

        return value === undefined || value === "" ? [] : [[key, value]];
      }),
    ),
  );
