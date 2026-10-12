/**
 * Watch state shared by browse, history, and playback: progress writes with stale-session
 * protection, next episodes, and continue watching.
 */
import type { Infer } from "convex/values";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { Audience } from "./access";
import { canSee } from "./access";
import { findProgress, presentEpisode, presentProgress, presentTitleCard } from "./present";
import type { continueWatchingItem } from "./validators";
import type { ReadCtx } from "./viewer";

/** Progress at or beyond this share of the duration marks an item watched. */
export const WATCHED_FRACTION = 0.9;

/** Whether a position counts as finished. Unknown durations never finish by position. */
export const reachedEnd = (positionMs: number, durationMs: number): boolean =>
  durationMs > 0 && positionMs >= durationMs * WATCHED_FRACTION;

/** A progress write from a playback session, an import, or a manual mark. */
export interface ProgressWrite {
  readonly profileId: Id<"profiles">;
  readonly titleId: Id<"titles">;
  readonly episodeId: Id<"episodes"> | null;
  readonly fileId: Id<"mediaFiles"> | null;
  readonly positionMs: number;
  readonly durationMs: number;
  readonly watched: boolean;
  readonly playedAt: number;
  /** The playback session reporting, when a device reports. */
  readonly session: Doc<"playbackSessions"> | null;
}

/**
 * Writes a profile's progress for one item. A report from a session that started before the
 * session now owning the item is stale and ignored, so an old tab cannot drag a newer device's
 * position back. Watched stays set until someone marks the item unwatched.
 *
 * @returns Whether the write applied, and the item's watched state after it.
 */
export const writeProgress = async (
  ctx: MutationCtx,
  write: ProgressWrite,
): Promise<{ readonly applied: boolean; readonly watched: boolean }> => {
  const existing = await findProgress(ctx, write.profileId, write.titleId, write.episodeId);
  const now = Date.now();

  const stale =
    write.session !== null &&
    existing?.sessionId !== undefined &&
    existing.sessionId !== write.session._id &&
    (existing.sessionStartedAt ?? 0) > write.session.startedAt;

  if (stale) return { applied: false, watched: existing.watched };
  const watched = write.watched || existing?.watched === true;

  const fields = {
    fileId: write.fileId ?? existing?.fileId ?? null,
    positionMs: write.positionMs,
    durationMs: write.durationMs,
    watched,
    updatedAt: now,
    lastPlayedAt: write.playedAt,
  };

  // A device's report takes ownership of the item; imports and manual marks leave the owner.
  const owned =
    write.session === null
      ? fields
      : { ...fields, sessionId: write.session._id, sessionStartedAt: write.session.startedAt };

  if (existing === null) {
    await ctx.db.insert("watchProgress", {
      profileId: write.profileId,
      titleId: write.titleId,
      episodeId: write.episodeId,
      ...owned,
    });
  } else {
    await ctx.db.patch(existing._id, owned);
  }

  return { applied: true, watched };
};

/** The episode after `episode` in season and episode order, specials (season 0) last. */
export const nextEpisodeAfter = async (
  ctx: ReadCtx,
  episode: Doc<"episodes">,
): Promise<Doc<"episodes"> | null> => {
  const sameSeason = await ctx.db
    .query("episodes")
    .withIndex("by_title_order", (q) =>
      q
        .eq("titleId", episode.titleId)
        .eq("seasonNumber", episode.seasonNumber)
        .gt("episodeNumber", episode.episodeNumber),
    )
    .first();

  if (sameSeason !== null || episode.seasonNumber === 0) return sameSeason;

  return ctx.db
    .query("episodes")
    .withIndex("by_title_order", (q) =>
      q.eq("titleId", episode.titleId).gt("seasonNumber", episode.seasonNumber),
    )
    .first();
};

/** A show's first regular episode (season 1 or later), or its first special when it has none. */
export const firstEpisode = async (
  ctx: ReadCtx,
  titleId: Id<"titles">,
): Promise<Doc<"episodes"> | null> => {
  const regular = await ctx.db
    .query("episodes")
    .withIndex("by_title_order", (q) => q.eq("titleId", titleId).gte("seasonNumber", 1))
    .first();

  return (
    regular ??
    ctx.db
      .query("episodes")
      .withIndex("by_title_order", (q) => q.eq("titleId", titleId))
      .first()
  );
};

/** The profile's most recently played episode progress of a show, if any. */
const latestShowProgress = async (
  ctx: ReadCtx,
  profileId: Id<"profiles">,
  titleId: Id<"titles">,
): Promise<Doc<"watchProgress"> | null> => {
  const rows = await ctx.db
    .query("watchProgress")
    .withIndex("by_profile_item", (q) => q.eq("profileId", profileId).eq("titleId", titleId))
    .collect();

  return rows.reduce<Doc<"watchProgress"> | null>(
    (latest, row) =>
      row.episodeId !== null && (latest === null || row.lastPlayedAt > latest.lastPlayedAt)
        ? row
        : latest,
    null,
  );
};

/**
 * The episode a show's Play button starts: the episode in progress, the one after the last
 * finished one, or the first episode. Null when the show is finished or has no episodes.
 */
export const upNextEpisode = async (
  ctx: ReadCtx,
  profileId: Id<"profiles">,
  titleId: Id<"titles">,
): Promise<Doc<"episodes"> | null> => {
  const latest = await latestShowProgress(ctx, profileId, titleId);

  if (latest?.episodeId === null || latest === null) return firstEpisode(ctx, titleId);
  const episode = await ctx.db.get(latest.episodeId);

  if (episode === null) return firstEpisode(ctx, titleId);

  return reachedEnd(latest.positionMs, latest.durationMs)
    ? nextEpisodeAfter(ctx, episode)
    : episode;
};

/** Most rows continue watching shows. */
const CONTINUE_LIMIT = 20;

/** How many recent progress rows continue watching considers. */
const CONTINUE_SCAN = 200;

/**
 * Continue watching for a profile, most recent first: movies and episodes in progress, and for
 * shows whose latest episode is finished, the next one. Each title appears once.
 */
export const continueWatching = async (
  ctx: ReadCtx,
  audience: Audience,
): Promise<Array<Infer<typeof continueWatchingItem>>> => {
  const rows = await ctx.db
    .query("watchProgress")
    .withIndex("by_profile_played", (q) => q.eq("profileId", audience.profile._id))
    .order("desc")
    .take(CONTINUE_SCAN);

  const seen = new Set<Id<"titles">>();
  const items: Array<Infer<typeof continueWatchingItem>> = [];

  const candidates = rows.filter((row) => {
    if (seen.has(row.titleId)) return false;
    seen.add(row.titleId);

    return true;
  });

  const resolved = await Promise.all(
    candidates.map(async (row) => {
      const title = await ctx.db.get(row.titleId);

      if (title === null || !canSee(audience, title)) return null;
      const finished = reachedEnd(row.positionMs, row.durationMs);

      if (row.episodeId === null) {
        return finished || row.positionMs <= 0
          ? null
          : {
              reason: "resume" as const,
              title: presentTitleCard(title),
              episode: null,
              progress: presentProgress(row),
            };
      }

      const episode = await ctx.db.get(row.episodeId);

      if (episode === null) return null;

      if (!finished && row.positionMs > 0) {
        return {
          reason: "resume" as const,
          title: presentTitleCard(title),
          episode: presentEpisode(episode, row),
          progress: presentProgress(row),
        };
      }

      const next = await nextEpisodeAfter(ctx, episode);

      if (next === null || next.presentFileCount === 0) return null;
      const nextProgress = await findProgress(ctx, audience.profile._id, title._id, next._id);

      if (nextProgress?.watched === true) return null;

      return {
        reason: "next" as const,
        title: presentTitleCard(title),
        episode: presentEpisode(next, nextProgress),
        progress: null,
      };
    }),
  );

  for (const item of resolved) {
    if (item !== null && items.length < CONTINUE_LIMIT) items.push(item);
  }

  return items;
};

/**
 * Titles from an index scan the profile may see, up to `limit`, reading at most `scanLimit`
 * documents so a heavily filtered profile cannot make one query read the whole table.
 */
export const visibleTitles = (
  audience: Audience,
  titles: ReadonlyArray<Doc<"titles">>,
  limit: number,
): Array<Doc<"titles">> => titles.filter((title) => canSee(audience, title)).slice(0, limit);
