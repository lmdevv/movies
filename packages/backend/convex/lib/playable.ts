/**
 * Picks the file a viewer plays for a movie or an episode, and lists the files on disk as versions
 * to choose from: the one the profile last played (its progress keeps the file), else the best the
 * device plays directly, else the best quality.
 */
import type { Doc, Id } from "../_generated/dataModel";
import { directPlayFile, playsDirectly } from "./directPlay";
import type { ClientCapabilities } from "./directPlay";
import { fail } from "./errors";
import type { ReadCtx } from "./viewer";

/** The movie or episode being played and the file that plays it. */
export interface Playable {
  readonly title: Doc<"titles">;
  readonly episode: Doc<"episodes"> | null;
  readonly file: Doc<"mediaFiles">;
}

const primaryVideo = (file: Doc<"mediaFiles">) => file.probe.video[0];

/**
 * Orders files best quality first: taller picture, then HDR, then higher bitrate, then larger.
 * Ties keep the older file first, so the order stays put as long as the files do.
 */
const byQuality = (left: Doc<"mediaFiles">, right: Doc<"mediaFiles">): number =>
  (primaryVideo(right)?.height ?? 0) - (primaryVideo(left)?.height ?? 0) ||
  Number(right.hdr) - Number(left.hdr) ||
  (right.probe.bitRate ?? 0) - (left.probe.bitRate ?? 0) ||
  right.sizeBytes - left.sizeBytes ||
  left._creationTime - right._creationTime;

/** The files of `files` that are on disk and belong to `episodeId` (null for a movie), best first. */
export const onDiskBestFirst = (
  files: ReadonlyArray<Doc<"mediaFiles">>,
  episodeId: Id<"episodes"> | null,
): Array<Doc<"mediaFiles">> =>
  files.filter((file) => !file.missing && file.episodeId === episodeId).toSorted(byQuality);

/**
 * The episode `episodeId` names, for a show, or null for a movie. Shows need an episode; fails
 * with `not_found` for an episode of another show.
 */
export const resolveEpisode = async (
  ctx: ReadCtx,
  title: Doc<"titles">,
  episodeId: Id<"episodes"> | null,
): Promise<Doc<"episodes"> | null> => {
  if (title.kind === "movie") return null;

  if (episodeId === null) return fail("invalid_args", "Pick an episode to play");

  const episode = await ctx.db.get(episodeId);

  if (episode?.titleId !== title._id) return fail("not_found", "No such episode");

  return episode;
};

/** A movie's (`episode` null) or an episode's files on disk, best quality first. */
export const filesOnDisk = async (
  ctx: ReadCtx,
  title: Doc<"titles">,
  episode: Doc<"episodes"> | null,
): Promise<Array<Doc<"mediaFiles">>> => {
  const files =
    episode === null
      ? await ctx.db
          .query("mediaFiles")
          .withIndex("by_title", (q) => q.eq("titleId", title._id))
          .collect()
      : await ctx.db
          .query("mediaFiles")
          .withIndex("by_episode", (q) => q.eq("episodeId", episode._id))
          .collect();

  return onDiskBestFirst(files, episode?._id ?? null);
};

/** What picks a file when none is asked for, after any one the profile last played. */
export interface FilePreference {
  /** The file the profile's progress names, preferred while it is on disk. */
  readonly lastPlayed: Id<"mediaFiles"> | null;
  /** The device, whose best direct-play file comes next; null skips that step. */
  readonly client: ClientCapabilities | null;
}

/** No preference: the best quality on disk. */
export const BEST_QUALITY: FilePreference = { lastPlayed: null, client: null };

/**
 * Resolves what plays for a movie (`episode` null) or an episode: the requested file, else the one
 * `preference` last played while it is on disk, else the best its device plays directly, else the
 * best quality. Fails with `not_found` for a file of another title or episode and `conflict` when
 * the file, or every file, is missing from disk.
 */
export const resolvePlayable = async (
  ctx: ReadCtx,
  title: Doc<"titles">,
  episode: Doc<"episodes"> | null,
  fileId: Id<"mediaFiles"> | null,
  preference: FilePreference,
): Promise<Playable> => {
  if (fileId !== null) {
    const file = await ctx.db.get(fileId);

    if (file?.titleId !== title._id || file.episodeId !== (episode?._id ?? null)) {
      return fail("not_found", "No such file for this title");
    }

    if (file.missing) return fail("conflict", "This file is missing from disk");

    return { title, episode, file };
  }

  const files = await filesOnDisk(ctx, title, episode);
  const { client, lastPlayed } = preference;

  const file =
    files.find((candidate) => candidate._id === lastPlayed) ??
    (client === null
      ? undefined
      : files.find((candidate) => playsDirectly(client, directPlayFile(candidate)))) ??
    files[0];

  if (file === undefined) return fail("conflict", "This title's files are missing from disk");

  return { title, episode, file };
};
