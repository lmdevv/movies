/** Scheduled upkeep: room presence, device codes, job leases, idle playback, backups, purges. */
import { v } from "convex/values";

import { internal } from "./_generated/api";
import { internalMutation, internalQuery } from "./_generated/server";
import { endPlaybackSession, endRoom, endTitlePlayback } from "./lib/endings";
import { enqueueJob } from "./lib/jobs";
import { failAttempt, LAPSED_LEASE_ERROR } from "./lib/jobOutcomes";
import { sortKeyOf } from "./lib/catalog";
import { removeTitleGenres, syncTitleGenres } from "./lib/genres";
import { removeTitleCredits } from "./lib/people";
import { overlappingLibraries as findOverlaps } from "./lib/roots";
import { PLAYBACK_TOKEN_LIFETIME_MS } from "./lib/playbackToken";
import { forgetTrickplay } from "./lib/trickplay";
import { endAuthSession } from "./lib/viewer";
import {
  HOST_PRESENCE_TIMEOUT_MS,
  isAbandoned,
  livePosition,
  presenceTimeout,
} from "./lib/roomClock";

/** Playback sessions without a report for this long end. */
const IDLE_PLAYBACK_MS = 30 * 60 * 1000;

/**
 * Download sessions report nothing while they transfer, and renewing the token is what keeps them
 * going; one not renewed for a token's lifetime and an hour more can fetch nothing, so it ends.
 */
const IDLE_DOWNLOAD_MS = PLAYBACK_TOKEN_LIFETIME_MS + 60 * 60 * 1000;

/** Expired device codes are deleted after this long. */
const DEVICE_CODE_RETENTION_MS = 24 * 60 * 60 * 1000;

const PURGE_BATCH = 200;

/**
 * Pauses rooms whose host stopped sending heartbeats, at the live position, and marks the host
 * away; ends rooms abandoned for half an hour (`isAbandoned`); drops guests who went silent.
 * Members whose last heartbeat said away get the longer `AWAY_PRESENCE_TIMEOUT_MS`
 * (`presenceTimeout`).
 */
export const sweepRooms = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();
    const statuses = ["playing", "buffering", "paused"] as const;

    const rooms = (
      await Promise.all(
        statuses.map((status) =>
          ctx.db
            .query("rooms")
            .withIndex("by_status", (q) => q.eq("status", status))
            .collect(),
        ),
      )
    ).flat();

    await Promise.all(
      rooms.map(async (room) => {
        const silentFor = now - room.hostLastSeenAt;

        const members = await ctx.db
          .query("roomMembers")
          .withIndex("by_room_device", (q) => q.eq("roomId", room._id))
          .collect();

        const host = members.find((member) => member.role === "host");
        const hostTimeout = host === undefined ? HOST_PRESENCE_TIMEOUT_MS : presenceTimeout(host);

        if (isAbandoned(room, members, now)) {
          await endRoom(ctx, room, now);
        } else if (silentFor > hostTimeout && room.status !== "paused") {
          await ctx.db.patch(room._id, {
            status: "paused",
            positionAtAnchorMs: livePosition(room, now),
            anchorServerTime: now,
            revision: room.revision + 1,
            hostAway: true,
          });
        } else if (silentFor > hostTimeout && !room.hostAway) {
          await ctx.db.patch(room._id, { hostAway: true });
        }

        await Promise.all(
          members.flatMap((member) =>
            member.role === "guest" && now - member.lastSeenAt > presenceTimeout(member)
              ? [ctx.db.delete(member._id)]
              : [],
          ),
        );
      }),
    );

    return null;
  },
});

/** Marks unused device codes expired, so watching devices see it, and deletes old ones. */
export const expireDeviceCodes = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();

    const lapsed = await ctx.db
      .query("deviceCodes")
      .withIndex("by_expires", (q) => q.lte("expiresAt", now))
      .take(500);

    await Promise.all(
      lapsed.map((code) => {
        if (code.expiresAt <= now - DEVICE_CODE_RETENTION_MS) return ctx.db.delete(code._id);

        return code.status === "pending" || code.status === "approved"
          ? ctx.db.patch(code._id, { status: "expired" })
          : Promise.resolve();
      }),
    );

    return null;
  },
});

/** Returns running jobs whose worker stopped renewing its lease to the queue, or fails them. */
export const releaseExpiredLeases = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();

    const running = await ctx.db
      .query("jobs")
      .withIndex("by_status", (q) => q.eq("status", "running"))
      .collect();

    const expired = running.filter((job) => (job.leaseExpiresAt ?? 0) <= now);

    await Promise.all(
      expired.map((job) => failAttempt(ctx, job, { error: LAPSED_LEASE_ERROR, retry: true })),
    );

    return null;
  },
});

/**
 * Ends playback sessions that stopped reporting, download sessions whose token was not renewed,
 * and sessions whose sign-in ended.
 */
export const endIdlePlayback = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();

    const active = await ctx.db
      .query("playbackSessions")
      .withIndex("by_status_report", (q) => q.eq("status", "active"))
      .collect();

    await Promise.all(
      active.map(async (session) => {
        const idle =
          now - session.lastReportAt >
          (session.purpose === "download" ? IDLE_DOWNLOAD_MS : IDLE_PLAYBACK_MS);

        const signedOut = (await ctx.db.get(session.authSessionId)) === null;

        if (idle || signedOut) {
          await endPlaybackSession(ctx, session, now);
        }
      }),
    );

    return null;
  },
});

/** Queues the nightly backup; the media service runs `convex export` and prunes old archives. */
export const requestNightlyBackup = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await enqueueJob(ctx, { kind: "backup", trigger: "nightly" }, null);

    return null;
  },
});

/** Titles one backfill step brings in step. */
const TITLE_BACKFILL_BATCH = 100;

/**
 * Brings every title's sort key and genre rows in step with its fields, a batch at a time,
 * rescheduling itself until done. Titles stored before the `titleGenres` table existed, or before
 * a sort-name override set the sort key, need it once; `scripts/configure.ts` runs it on every
 * deploy, and a pass over titles already in step writes nothing.
 */
export const backfillTitleIndexes = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.null(),
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db
      .query("titles")
      .paginate({ numItems: TITLE_BACKFILL_BATCH, cursor: cursor ?? null });

    await Promise.all(
      page.page.map(async (title) => {
        const sortKey = sortKeyOf(title);

        if (sortKey !== title.sortKey) await ctx.db.patch(title._id, { sortKey });
        await syncTitleGenres(ctx, { ...title, sortKey });
      }),
    );

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.maintenance.backfillTitleIndexes, {
        cursor: page.continueCursor,
      });
    }

    return null;
  },
});

/**
 * Deletes a removed library's catalog in batches, rescheduling until it is gone: files, then
 * titles with their seasons, episodes, and collection memberships. Each batch first ends the
 * playback sessions and rooms on the titles it touches. History stays.
 */
export const purgeLibrary = internalMutation({
  args: { libraryId: v.id("libraries") },
  returns: v.null(),
  handler: async (ctx, { libraryId }) => {
    const files = await ctx.db
      .query("mediaFiles")
      .withIndex("by_library_path", (q) => q.eq("libraryId", libraryId))
      .take(PURGE_BATCH);

    const now = Date.now();

    if (files.length > 0) {
      // Playback of these files' titles ends as the files go, a batch at a time.
      await Promise.all(
        [...new Set(files.map((file) => file.titleId))].map((titleId) =>
          endTitlePlayback(ctx, titleId, now),
        ),
      );
      // Thumbnail jobs of the library's files would only fail once their files are gone.
      await Promise.all(files.map((file) => forgetTrickplay(ctx, file)));
      await Promise.all(files.map((file) => ctx.db.delete(file._id)));
      await ctx.scheduler.runAfter(0, internal.maintenance.purgeLibrary, { libraryId });

      return null;
    }

    const titles = await ctx.db
      .query("titles")
      .withIndex("by_library", (q) => q.eq("libraryId", libraryId))
      .take(20);

    // Credits go in passes of their own, a share of the batch per title, so a pass that deletes
    // credits never also deletes titles with their seasons and episodes.
    const removed = await Promise.all(
      titles.map((title) =>
        removeTitleCredits(ctx, title._id, Math.max(1, Math.floor(PURGE_BATCH / titles.length))),
      ),
    );

    if (removed.some((count) => count > 0)) {
      await ctx.scheduler.runAfter(0, internal.maintenance.purgeLibrary, { libraryId });

      return null;
    }

    await Promise.all(
      titles.map(async (title) => {
        const seasons = await ctx.db
          .query("seasons")
          .withIndex("by_title_number", (q) => q.eq("titleId", title._id))
          .collect();

        const episodes = await ctx.db
          .query("episodes")
          .withIndex("by_title_order", (q) => q.eq("titleId", title._id))
          .collect();

        const memberships = await ctx.db
          .query("collectionItems")
          .withIndex("by_title", (q) => q.eq("titleId", title._id))
          .collect();

        await endTitlePlayback(ctx, title._id, now);
        await Promise.all(
          [...seasons, ...episodes, ...memberships].map((doc) => ctx.db.delete(doc._id)),
        );
        await removeTitleGenres(ctx, title._id);
        await ctx.db.delete(title._id);
      }),
    );

    if (titles.length > 0)
      await ctx.scheduler.runAfter(0, internal.maintenance.purgeLibrary, { libraryId });

    return null;
  },
});

/**
 * Signs out every session, for the restore procedure: a restored snapshot carries the sessions
 * and refresh tokens it was taken with, and they keep working until ended. Run it with
 * `convex run maintenance:endAllSessions` after `convex import`; it reschedules itself until done.
 * The media service signs in again with its key.
 */
export const endAllSessions = internalMutation({
  args: {},
  returns: v.object({ ended: v.number() }),
  handler: async (ctx) => {
    const sessions = await ctx.db.query("authSessions").take(PURGE_BATCH);

    await Promise.all(sessions.map((session) => endAuthSession(ctx, session._id)));

    if (sessions.length === PURGE_BATCH) {
      await ctx.scheduler.runAfter(0, internal.maintenance.endAllSessions, {});
    }

    return { ended: sessions.length };
  },
});

/**
 * Settles jobs a restored snapshot caught mid-run, for the restore procedure, before
 * `endAllSessions`: the snapshot was taken while its own backup job ran, and other jobs may have
 * been running too. Running backup jobs are marked succeeded (the archive being restored is their
 * result); every other running job returns to the queue at once instead of waiting for its lease
 * to expire, since the worker that held it has moved on.
 */
export const settleRestoredJobs = internalMutation({
  args: {},
  returns: v.object({ settled: v.number() }),
  handler: async (ctx) => {
    const now = Date.now();

    const running = await ctx.db
      .query("jobs")
      .withIndex("by_status", (q) => q.eq("status", "running"))
      .collect();

    await Promise.all(
      running.map((job) =>
        ctx.db.patch(
          job._id,
          job.kind === "backup"
            ? {
                status: "succeeded",
                finishedAt: now,
                leaseOwner: undefined,
                leaseExpiresAt: undefined,
                progress: { ...job.progress, message: "Restored from this backup" },
              }
            : { status: "pending", leaseOwner: undefined, leaseExpiresAt: undefined },
        ),
      ),
    );

    return { settled: running.length };
  },
});

/**
 * Removes a forgotten profile PIN, for the operator: `convex run maintenance:clearProfilePin
 * '{"profileId":"..."}'` with the deployment's admin key. No signed-in session can do this, since
 * changing a PIN profile needs it unlocked.
 */
export const clearProfilePin = internalMutation({
  args: { profileId: v.id("profiles") },
  returns: v.object({ cleared: v.boolean() }),
  handler: async (ctx, { profileId }) => {
    const profile = await ctx.db.get(profileId);

    if (profile?.pinHash === undefined) return { cleared: false };

    await ctx.db.patch(profileId, {
      pinHash: undefined,
      pinSalt: undefined,
      pinFailures: 0,
      pinLockedUntil: undefined,
    });

    return { cleared: true };
  },
});

/**
 * Lists libraries whose folders overlap, for the operator: `convex run
 * maintenance:overlappingLibraries`. New folders can no longer overlap, but libraries made before
 * that rule may; a grant on either exposes the other's files until one's folders change.
 */
export const overlappingLibraries = internalQuery({
  args: {},
  returns: v.array(v.object({ outer: v.string(), inner: v.string(), folder: v.string() })),
  handler: async (ctx) => findOverlaps(await ctx.db.query("libraries").collect()),
});
