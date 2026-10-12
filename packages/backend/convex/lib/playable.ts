/** Picks the file a viewer plays for a movie or an episode. */
import type { Doc, Id } from "../_generated/dataModel";
import { fail } from "./errors";
import type { ReadCtx } from "./viewer";

/** The movie or episode being played and the file that plays it. */
export interface Playable {
  readonly title: Doc<"titles">;
  readonly episode: Doc<"episodes"> | null;
  readonly file: Doc<"mediaFiles">;
}

const height = (file: Doc<"mediaFiles">): number => file.probe.video[0]?.height ?? 0;

/**
 * Resolves what to play: the requested file, or the present file with the tallest video. Shows
 * need an episode. Fails with `not_found` for a mismatched episode or file and `conflict` when
 * every file is missing from disk.
 */
export const resolvePlayable = async (
  ctx: ReadCtx,
  title: Doc<"titles">,
  episodeId: Id<"episodes"> | null,
  fileId: Id<"mediaFiles"> | null,
): Promise<Playable> => {
  if (title.kind === "show" && episodeId === null) {
    return fail("invalid_args", "Pick an episode to play");
  }

  const episode = episodeId === null || title.kind === "movie" ? null : await ctx.db.get(episodeId);

  if (episodeId !== null && title.kind === "show" && episode?.titleId !== title._id) {
    return fail("not_found", "No such episode");
  }

  const expectedEpisode = episode?._id ?? null;

  if (fileId !== null) {
    const file = await ctx.db.get(fileId);

    if (file?.titleId !== title._id || file.episodeId !== expectedEpisode) {
      return fail("not_found", "No such file for this title");
    }

    if (file.missing) return fail("conflict", "This file is missing from disk");

    return { title, episode, file };
  }

  const files =
    expectedEpisode === null
      ? await ctx.db
          .query("mediaFiles")
          .withIndex("by_title", (q) => q.eq("titleId", title._id))
          .collect()
      : await ctx.db
          .query("mediaFiles")
          .withIndex("by_episode", (q) => q.eq("episodeId", expectedEpisode))
          .collect();

  const [best] = files
    .filter((file) => !file.missing && file.episodeId === expectedEpisode)
    .toSorted((left, right) => height(right) - height(left));

  if (best === undefined) return fail("conflict", "This title's files are missing from disk");

  return { title, episode, file: best };
};
