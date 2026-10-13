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

/**
 * Whether a progress row counts as finished: played to the end, or marked watched without a
 * position in progress (a manual mark, or an import, of an item with unknown duration). A rewatch
 * in progress is not finished, so it shows up to resume.
 */
export const isFinished = (row: Doc<"watchProgress">): boolean =>
  reachedEnd(row.positionMs, row.durationMs) || (row.watched && row.positionMs <= 0);

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

/** Most watched episodes `nextUnwatchedAfter` steps over, so a long finished run stays cheap. */
const MAX_SKIPPED_EPISODES = 100;

/** Up to `count` episodes after `episode` in the order `nextEpisodeAfter` walks, in two reads. */
const followingEpisodes = async (
  ctx: ReadCtx,
  episode: Doc<"episodes">,
  count: number,
): Promise<Array<Doc<"episodes">>> => {
  const sameSeason = await ctx.db
    .query("episodes")
    .withIndex("by_title_order", (q) =>
      q
        .eq("titleId", episode.titleId)
        .eq("seasonNumber", episode.seasonNumber)
        .gt("episodeNumber", episode.episodeNumber),
    )
    .take(count);

  if (sameSeason.length >= count || episode.seasonNumber === 0) return sameSeason;

  const later = await ctx.db
    .query("episodes")
    .withIndex("by_title_order", (q) =>
      q.eq("titleId", episode.titleId).gt("seasonNumber", episode.seasonNumber),
    )
    .take(count - sameSeason.length);

  return [...sameSeason, ...later];
};

/** The first of `episodes` the profile has not watched, and how many progress rows it read. */
const firstUnwatched = async (
  ctx: ReadCtx,
  profileId: Id<"profiles">,
  episodes: ReadonlyArray<Doc<"episodes">>,
  index: number,
): Promise<{ readonly episode: Doc<"episodes"> | null; readonly examined: number }> => {
  const next = episodes[index];

  if (next === undefined) return { episode: null, examined: index };
  const progress = await findProgress(ctx, profileId, next.titleId, next._id);

  return progress?.watched === true
    ? firstUnwatched(ctx, profileId, episodes, index + 1)
    : { episode: next, examined: index + 1 };
};

/** Episodes `scanUnwatched` reads at a time; most next episodes are the first one read. */
const SCAN_BATCH = 10;

/**
 * The first episode after `episode` the profile has not watched, or null when none remains. Reads
 * the following episodes a few at a time, widening only while every one read is watched, and
 * checks each one's progress by index. After `maxSkipped` watched episodes in a row it stops:
 * with `giveUp` it returns the next one anyway, as for a long finished run; without, null, for a
 * caller whose read budget cut the search short.
 *
 * @returns The episode and how many documents it read, for callers that share a read budget.
 */
const scanUnwatched = async (
  ctx: ReadCtx,
  profileId: Id<"profiles">,
  episode: Doc<"episodes">,
  maxSkipped: number,
  giveUp: boolean,
): Promise<{ readonly episode: Doc<"episodes"> | null; readonly reads: number }> => {
  const step = async (
    after: Doc<"episodes">,
    skipped: number,
    reads: number,
  ): Promise<{ readonly episode: Doc<"episodes"> | null; readonly reads: number }> => {
    const left = maxSkipped - skipped;
    // The last batch reads one past the run, the episode returned when giving up.
    const wanted = left <= SCAN_BATCH ? left + 1 : SCAN_BATCH;
    const batch = await followingEpisodes(ctx, after, wanted);
    const found = await firstUnwatched(ctx, profileId, batch.slice(0, left), 0);
    const spent = reads + batch.length + found.examined;

    if (found.episode !== null) return { episode: found.episode, reads: spent };

    // Every episode read is watched: none remain, the run is too long, or read further.
    if (batch.length < wanted) return { episode: null, reads: spent };

    if (found.examined >= left) {
      return { episode: giveUp ? (batch[left] ?? null) : null, reads: spent };
    }

    const last = batch.at(-1);

    return last === undefined
      ? { episode: null, reads: spent }
      : step(last, skipped + found.examined, spent);
  };

  return step(episode, 0, 0);
};

/** The first episode after `episode` the profile has not watched, or null when none remains. */
export const nextUnwatchedAfter = async (
  ctx: ReadCtx,
  profileId: Id<"profiles">,
  episode: Doc<"episodes">,
): Promise<Doc<"episodes"> | null> =>
  (await scanUnwatched(ctx, profileId, episode, MAX_SKIPPED_EPISODES, true)).episode;

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

  return isFinished(latest) ? nextUnwatchedAfter(ctx, profileId, episode) : episode;
};

/** Most rows continue watching shows. */
const CONTINUE_LIMIT = 20;

/** How many recent progress rows continue watching considers. */
const CONTINUE_SCAN = 200;

/**
 * Documents (episodes and their progress rows) continue watching may read in all while finding
 * next episodes, so a profile with many finished shows cannot push one query past Convex's limits.
 */
const NEXT_EPISODE_BUDGET = 500;

type ContinueItem = Infer<typeof continueWatchingItem>;

/** What one progress row adds to continue watching, before any next-episode lookup. */
type Candidate =
  | { readonly kind: "skip" }
  | { readonly kind: "item"; readonly item: ContinueItem }
  | {
      readonly kind: "next";
      readonly title: Doc<"titles">;
      readonly episode: Doc<"episodes">;
    };

const SKIP: Candidate = { kind: "skip" };

/** Resolves a progress row with point reads only; finished episodes still need their next one. */
const candidateOf = async (
  ctx: ReadCtx,
  audience: Audience,
  row: Doc<"watchProgress">,
): Promise<Candidate> => {
  const title = await ctx.db.get(row.titleId);

  if (title === null || !canSee(audience, title)) return SKIP;
  const finished = isFinished(row);

  if (row.episodeId === null) {
    return finished || row.positionMs <= 0
      ? SKIP
      : {
          kind: "item",
          item: {
            reason: "resume",
            title: presentTitleCard(title),
            episode: null,
            progress: presentProgress(row),
          },
        };
  }

  const episode = await ctx.db.get(row.episodeId);

  if (episode === null) return SKIP;

  if (!finished && row.positionMs > 0) {
    return {
      kind: "item",
      item: {
        reason: "resume",
        title: presentTitleCard(title),
        episode: presentEpisode(episode, row),
        progress: presentProgress(row),
      },
    };
  }

  return { kind: "next", title, episode };
};

/** The next episode for a finished one, within what is left of the read budget. */
const nextItemOf = async (
  ctx: ReadCtx,
  audience: Audience,
  title: Doc<"titles">,
  episode: Doc<"episodes">,
  budget: number,
): Promise<{ readonly item: ContinueItem | null; readonly reads: number }> => {
  // Each episode looked at costs its episode and its progress row, plus one episode past the run
  // and the found episode's progress again to show it: at most `2 * maxSkipped + 2` reads.
  const maxSkipped = Math.min(MAX_SKIPPED_EPISODES, Math.floor((budget - 2) / 2));

  if (maxSkipped < 1) return { item: null, reads: 0 };

  const { episode: next, reads } = await scanUnwatched(
    ctx,
    audience.profile._id,
    episode,
    maxSkipped,
    maxSkipped === MAX_SKIPPED_EPISODES,
  );

  if (next === null || next.presentFileCount === 0) return { item: null, reads };
  const nextProgress = await findProgress(ctx, audience.profile._id, title._id, next._id);

  return {
    item: {
      reason: "next",
      title: presentTitleCard(title),
      episode: presentEpisode(next, nextProgress),
      progress: null,
    },
    reads: reads + 1,
  };
};

/**
 * Continue watching for a profile, most recent first: movies and episodes in progress, and for
 * shows whose latest episode is finished, the next one. Each title appears once. Rows resolve
 * with point reads in parallel; next-episode lookups then run in order until the row is full and
 * share one read budget.
 */
export const continueWatching = async (
  ctx: ReadCtx,
  audience: Audience,
): Promise<Array<ContinueItem>> => {
  const rows = await ctx.db
    .query("watchProgress")
    .withIndex("by_profile_played", (q) => q.eq("profileId", audience.profile._id))
    .order("desc")
    .take(CONTINUE_SCAN);

  const seen = new Set<Id<"titles">>();

  const candidates = await Promise.all(
    rows
      .filter((row) => {
        if (seen.has(row.titleId)) return false;
        seen.add(row.titleId);

        return true;
      })
      .map((row) => candidateOf(ctx, audience, row)),
  );

  const collect = async (
    index: number,
    items: ReadonlyArray<ContinueItem>,
    budget: number,
  ): Promise<Array<ContinueItem>> => {
    const candidate = candidates[index];

    if (candidate === undefined || items.length >= CONTINUE_LIMIT) return [...items];

    if (candidate.kind === "skip") return collect(index + 1, items, budget);

    if (candidate.kind === "item") return collect(index + 1, [...items, candidate.item], budget);

    const { item, reads } = await nextItemOf(
      ctx,
      audience,
      candidate.title,
      candidate.episode,
      budget,
    );

    return collect(index + 1, item === null ? items : [...items, item], budget - reads);
  };

  return collect(0, [], NEXT_EPISODE_BUDGET);
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
