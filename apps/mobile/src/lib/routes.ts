/**
 * Links into the player and what they carry: the title, an episode for shows, a chosen version
 * (file), `start` (`beginning` to start over, `resume` to resume without asking), `at` to start at a
 * position (a watch room's, when a guest goes on alone), and the watch room to play in. Screens link
 * with `watchHref`, which writes them in one order; the player reads them back with
 * `parseWatchParams`, which never throws.
 */
import { EpisodeId, MediaFileId, RoomId, TitleId } from "@movies/contracts/ids";
import { Schema } from "effect";
import type { Option } from "effect";

/** What to play: a movie, or a show's episode, in a chosen version, and from where. */
export interface WatchTarget {
  readonly titleId: TitleId;
  /** The episode of a show; omit for a movie, or to let the player choose a show's next one. */
  readonly episodeId?: EpisodeId | undefined;
  /** A version from `titles.versions`; omit to let the server choose. */
  readonly fileId?: MediaFileId | undefined;
  /**
   * `beginning` for Start Over, `resume` to pick up the saved progress without asking, as the next
   * episode does; omit to ask before resuming.
   */
  readonly start?: "beginning" | "resume" | undefined;
  /** Where to start, in milliseconds, without asking to resume; omit for the saved progress. */
  readonly at?: number | undefined;
  /** The watch room this device joined, whose timeline the player follows; omit to play alone. */
  readonly room?: RoomId | undefined;
}

/**
 * The player's href for `target`. Present parameters appear in the order `episodeId`, `fileId`,
 * `start`, `at` (whole milliseconds), `room`, each URI-encoded, so `new URLSearchParams(query)` reads back the same values.
 */
export const watchHref = ({ titleId, episodeId, fileId, start, at, room }: WatchTarget): string => {
  const query = (
    [
      ["episodeId", episodeId],
      ["fileId", fileId],
      ["start", start],
      ["at", at === undefined ? undefined : String(Math.max(0, Math.round(at)))],
      ["room", room],
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
  start: Schema.optionalKey(Schema.Literals(["beginning", "resume"])),
  at: Schema.optionalKey(Schema.FiniteFromString.check(Schema.isGreaterThanOrEqualTo(0))),
  room: Schema.optionalKey(RoomId),
});

/** What the player plays, read from its route. */
export interface WatchParams extends Schema.Schema.Type<typeof WatchParams> {}

const decodeWatchParams = Schema.decodeUnknownOption(WatchParams);

/** A route's params as Expo Router reads them: a repeated key gives an array. */
type RouteParams = Readonly<Record<string, string | string[] | undefined>>;

const KEYS = ["titleId", "episodeId", "fileId", "start", "at", "room"] as const;

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
