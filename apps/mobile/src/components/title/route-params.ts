/**
 * Reading the title screens' route parameters. Links come from anywhere (other screens, deep
 * links), so each parameter is parsed, and one that does not parse reads as absent rather than
 * throwing during render.
 */
import { EpisodeId, MediaFileId, TitleId } from "@movies/contracts/ids";
import { Option, Schema } from "effect";

/** A route parameter as Expo Router hands it over. */
type RawParam = string | ReadonlyArray<string> | undefined;

/** The value, or the first of repeated values. */
const single = (raw: RawParam): string | undefined => [raw].flat()[0];

const decoder =
  <A>(schema: Schema.Codec<A, string>) =>
  (raw: RawParam): A | null =>
    Option.getOrNull(Schema.decodeUnknownOption(schema)(single(raw)));

/** The title in a `/title/<titleId>` route, or null when the link names none. */
export const titleIdParam = decoder(TitleId);

/** The `episodeId` parameter, or null. */
export const episodeIdParam = decoder(EpisodeId);

/** The `fileId` parameter, a version from `titles.versions`, or null. */
export const fileIdParam = decoder(MediaFileId);

const SEASON = /^\d{1,4}$/u;

/** The `season` parameter, a season number such as `2` (0 for specials), or null. */
export const seasonParam = (raw: RawParam): number | null => {
  const value = single(raw);

  return value !== undefined && SEASON.test(value) ? Number(value) : null;
};
