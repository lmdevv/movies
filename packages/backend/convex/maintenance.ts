/** Scheduled upkeep: room presence, device codes, job leases, idle playback, backups, purges. */
import { v } from "convex/values";

import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { enqueueJob, MAX_JOB_ATTEMPTS } from "./lib/jobs";
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
        await ctx.db.delete(title._id);
      }),
    );

    if (titles.length > 0)
      await ctx.scheduler.runAfter(0, internal.maintenance.purgeLibrary, { libraryId });

    return null;
  },
});
