/** Scheduled upkeep: room presence, device codes, job leases, idle playback, backups, purges. */
import { v } from "convex/values";

import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { enqueueJob, MAX_JOB_ATTEMPTS } from "./lib/jobs";
import { removeTitleGenres, syncTitleGenres } from "./lib/genres";
import { removeTitleCredits } from "./lib/people";
import { endAuthSession } from "./lib/viewer";
import {
  HOST_ABANDON_TIMEOUT_MS,
  HOST_PRESENCE_TIMEOUT_MS,
  livePosition,
  MEMBER_PRESENCE_TIMEOUT_MS,
} from "./lib/roomClock";

/** Playback sessions without a report for this long end. */
const IDLE_PLAYBACK_MS = 30 * 60 * 1000;

/** Expired device codes are deleted after this long. */
const DEVICE_CODE_RETENTION_MS = 24 * 60 * 60 * 1000;

const PURGE_BATCH = 200;

/**
 * Pauses rooms whose host stopped sending heartbeats, at the live position, and marks the host
 * away; ends rooms abandoned for half an hour; drops guests who went silent.
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

        if (silentFor > HOST_ABANDON_TIMEOUT_MS) {
          await ctx.db.patch(room._id, {
            status: "ended",
            positionAtAnchorMs: livePosition(room, now),
            anchorServerTime: now,
            revision: room.revision + 1,
            endedAt: now,
          });
        } else if (silentFor > HOST_PRESENCE_TIMEOUT_MS && room.status !== "paused") {
          await ctx.db.patch(room._id, {
            status: "paused",
            positionAtAnchorMs: livePosition(room, now),
            anchorServerTime: now,
            revision: room.revision + 1,
            hostAway: true,
          });
        } else if (silentFor > HOST_PRESENCE_TIMEOUT_MS && !room.hostAway) {
          await ctx.db.patch(room._id, { hostAway: true });
        }

        const members = await ctx.db
          .query("roomMembers")
          .withIndex("by_room_device", (q) => q.eq("roomId", room._id))
          .collect();

        await Promise.all(
          members.flatMap((member) =>
            member.role === "guest" && now - member.lastSeenAt > MEMBER_PRESENCE_TIMEOUT_MS
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

    await Promise.all(
      running.flatMap((job) =>
        (job.leaseExpiresAt ?? 0) <= now
          ? [
              ctx.db.patch(job._id, {
                status: job.attempts >= MAX_JOB_ATTEMPTS ? "failed" : "pending",
                error: "The worker stopped responding",
                leaseOwner: undefined,
                leaseExpiresAt: undefined,
                finishedAt: job.attempts >= MAX_JOB_ATTEMPTS ? now : null,
              }),
            ]
          : [],
      ),
    );

    return null;
  },
});

/** Ends playback sessions that stopped reporting or whose sign-in ended. */
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
        const idle = now - session.lastReportAt > IDLE_PLAYBACK_MS;
        const signedOut = (await ctx.db.get(session.authSessionId)) === null;

        if (idle || signedOut) {
          await ctx.db.patch(session._id, { status: "ended", state: "paused", endedAt: now });
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

/** Titles whose genre rows one backfill step writes. */
const GENRE_BACKFILL_BATCH = 100;

/**
 * Writes the genre rows of every title, a batch at a time, rescheduling itself until done. Titles
 * stored before the `titleGenres` table existed need it once; `scripts/configure.ts` runs it on
 * every deploy, and a pass over titles already in step writes nothing.
 */
export const backfillTitleGenres = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.null(),
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db
      .query("titles")
      .paginate({ numItems: GENRE_BACKFILL_BATCH, cursor: cursor ?? null });

    await Promise.all(page.page.map((title) => syncTitleGenres(ctx, title)));

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.maintenance.backfillTitleGenres, {
        cursor: page.continueCursor,
      });
    }

    return null;
  },
});

/** Deletes a removed library's catalog in batches, rescheduling until it is gone. History stays. */
export const purgeLibrary = internalMutation({
  args: { libraryId: v.id("libraries") },
  returns: v.null(),
  handler: async (ctx, { libraryId }) => {
    const files = await ctx.db
      .query("mediaFiles")
      .withIndex("by_library_path", (q) => q.eq("libraryId", libraryId))
      .take(PURGE_BATCH);

    if (files.length > 0) {
      await Promise.all(files.map((file) => ctx.db.delete(file._id)));
      await ctx.scheduler.runAfter(0, internal.maintenance.purgeLibrary, { libraryId });

      return null;
    }

    const titles = await ctx.db
      .query("titles")
      .withIndex("by_library", (q) => q.eq("libraryId", libraryId))
      .take(20);

    const cleared = await Promise.all(
      titles.map((title) => removeTitleCredits(ctx, title._id, PURGE_BATCH)),
    );

    if (cleared.includes(false)) {
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

        await Promise.all([...seasons, ...episodes].map((doc) => ctx.db.delete(doc._id)));
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
