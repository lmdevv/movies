/**
 * Watch rooms: a stored, anchored clock that members follow with their own streams. Only the
 * host's device changes the clock, and every change carries the revision the host last saw; an
 * older revision fails with `stale_revision`. Guests only join, heartbeat, and leave.
 */
import { v } from "convex/values";
import type { Infer } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { canSee, loadAudience, loadVisibleTitle, visibleLibraryIds } from "./lib/access";
import { checkDeviceId, checkMilliseconds } from "./lib/bounds";
import { fail } from "./lib/errors";
import { resolvePlayable } from "./lib/playable";
import { presentEpisode, presentRoomClock, presentTitleCard } from "./lib/present";
import { HOST_REANCHOR_THRESHOLD_MS, livePosition } from "./lib/roomClock";
import { hostControlArgs, ok, room as roomResult, roomClock } from "./lib/validators";
import type { Viewer } from "./lib/viewer";
import { authorize } from "./lib/viewer";

type RoomPatch = Partial<
  Pick<
    Doc<"rooms">,
    "status" | "positionAtAnchorMs" | "anchorServerTime" | "titleId" | "episodeId" | "fileId"
  >
>;

const loadRoom = async (ctx: QueryCtx, roomId: Id<"rooms">): Promise<Doc<"rooms">> => {
  const found = await ctx.db.get(roomId);

  if (found === null) return fail("not_found", "No such room");

  return found;
};

const presentRoom = async (ctx: QueryCtx, doc: Doc<"rooms">): Promise<Infer<typeof roomResult>> => {
  const title = await ctx.db.get(doc.titleId);

  if (title === null) return fail("not_found", "This room's title is gone");
  const episodeDoc = doc.episodeId === null ? null : await ctx.db.get(doc.episodeId);

  const members = await ctx.db
    .query("roomMembers")
    .withIndex("by_room_device", (q) => q.eq("roomId", doc._id))
    .collect();

  const profiles = await Promise.all(members.map((member) => ctx.db.get(member.profileId)));
  const hostProfile = await ctx.db.get(doc.hostProfileId);

  return {
    id: doc._id,
    title: presentTitleCard(title),
    episode:
      // Without the host profile's progress: guests are other accounts.
      episodeDoc === null ? null : presentEpisode(episodeDoc, null),
    fileId: doc.fileId,
    hostUserId: doc.hostUserId,
    hostProfileId: doc.hostProfileId,
    hostDeviceId: doc.hostDeviceId,
    hostProfileName: hostProfile?.name ?? "Host",
    hostAway: doc.hostAway,
    clock: presentRoomClock(doc),
    members: members.map((member, index) => ({
      userId: member.userId,
      profileId: member.profileId,
      profileName: profiles[index]?.name ?? "Profile",
      avatar: profiles[index]?.avatar ?? "red",
      deviceId: member.deviceId,
      role: member.role,
      joinedAt: member.joinedAt,
      lastSeenAt: member.lastSeenAt,
      driftMs: member.role === "guest" ? (member.driftMs ?? null) : null,
    })),
    createdAt: Math.floor(doc._creationTime),
  };
};

/** The viewer's memberships of the room, one per device it joined on. */
const membershipsOf = async (
  ctx: QueryCtx,
  viewer: Viewer,
  roomId: Id<"rooms">,
): Promise<Array<Doc<"roomMembers">>> => {
  const members = await ctx.db
    .query("roomMembers")
    .withIndex("by_room_device", (q) => q.eq("roomId", roomId))
    .collect();

  return members.filter((member) => member.userId === viewer.userId);
};

/**
 * Whether one of the profiles the viewer joined with may still see the room's title: the host can
 * switch the room to a title a guest's profile may not see, and then that guest stops seeing it.
 */
const membersMaySee = async (
  ctx: QueryCtx,
  viewer: Viewer,
  memberships: ReadonlyArray<Doc<"roomMembers">>,
  title: Doc<"titles">,
): Promise<boolean> => {
  const libraryIds = await visibleLibraryIds(ctx, viewer);
  const profiles = await Promise.all(memberships.map((member) => ctx.db.get(member.profileId)));

  return profiles.some(
    (profile) => profile !== null && canSee({ viewer, profile, libraryIds }, title),
  );
};

/**
 * Applies a host command: requires the host's account and device, a live room, and the room's
 * current revision, then writes the change with the next revision.
 */
const hostCommand = async (
  ctx: MutationCtx,
  args: { roomId: Id<"rooms">; deviceId: string; revision: number },
  change: (current: Doc<"rooms">, now: number) => RoomPatch,
): Promise<Infer<typeof roomClock>> => {
  const viewer = await authorize(ctx, "play");
  const current = await loadRoom(ctx, args.roomId);

  if (current.status === "ended") return fail("conflict", "This room has ended");

  if (current.hostUserId !== viewer.userId || current.hostDeviceId !== args.deviceId) {
    return fail("forbidden", "Only the host's device controls the room");
  }

  if (args.revision !== current.revision) {
    return fail("stale_revision", "The room changed; read its clock and try again");
  }

  const now = Date.now();

  await ctx.db.patch(current._id, {
    ...change(current, now),
    revision: current.revision + 1,
    hostLastSeenAt: now,
    hostAway: false,
  });

  return presentRoomClock(await loadRoom(ctx, current._id));
};

const checkPosition = (positionMs: number): number => checkMilliseconds(positionMs, "Positions");

export const create = mutation({
  args: {
    profileId: v.id("profiles"),
    deviceId: v.string(),
    titleId: v.id("titles"),
    episodeId: v.optional(v.id("episodes")),
    fileId: v.optional(v.id("mediaFiles")),
    positionMs: v.number(),
  },
  returns: roomResult,
  handler: async (ctx, args) => {
    const viewer = await authorize(ctx, "play");
    checkDeviceId(args.deviceId);
    const audience = await loadAudience(ctx, viewer, args.profileId);
    const title = await loadVisibleTitle(ctx, audience, args.titleId);

    const playable = await resolvePlayable(ctx, title, args.episodeId ?? null, args.fileId ?? null);

    const now = Date.now();

    const existing = await ctx.db
      .query("roomMembers")
      .withIndex("by_user_device", (q) =>
        q.eq("userId", viewer.userId).eq("deviceId", args.deviceId),
      )
      .collect();

    // A device is in one room at a time: hosting a new room ends rooms it hosted and leaves others.
    await Promise.all(
      existing.map(async (member) => {
        const previous = await ctx.db.get(member.roomId);

        if (previous !== null && member.role === "host" && previous.status !== "ended") {
          await ctx.db.patch(previous._id, {
            status: "ended",
            endedAt: now,
            revision: previous.revision + 1,
          });
        }

        await ctx.db.delete(member._id);
      }),
    );

    const roomId = await ctx.db.insert("rooms", {
      titleId: title._id,
      episodeId: playable.episode?._id ?? null,
      fileId: playable.file._id,
      hostUserId: viewer.userId,
      hostProfileId: args.profileId,
      hostDeviceId: args.deviceId,
      status: "paused",
      positionAtAnchorMs: checkPosition(args.positionMs),
      anchorServerTime: now,
      playbackRate: 1,
      revision: 0,
      hostLastSeenAt: now,
      hostAway: false,
    });

    await ctx.db.insert("roomMembers", {
      roomId,
      userId: viewer.userId,
      profileId: args.profileId,
      deviceId: args.deviceId,
      role: "host",
      joinedAt: now,
      lastSeenAt: now,
    });

    return presentRoom(ctx, await loadRoom(ctx, roomId));
  },
});

/**
 * A room as its members see it, while a profile they joined with may see its title. Someone with
 * the room's link who has not joined names the profile they would join with: when that profile may
 * see the title they get the room without its members, so the link page can open the player.
 * Everyone else gets `not_found`, as for a missing room.
 */
export const get = query({
  args: { roomId: v.id("rooms"), profileId: v.optional(v.id("profiles")) },
  returns: roomResult,
  handler: async (ctx, { roomId, profileId }) => {
    const viewer = await authorize(ctx, "read");
    const found = await loadRoom(ctx, roomId);
    const title = await ctx.db.get(found.titleId);

    if (title === null) return fail("not_found", "No such room");
    const memberships = await membershipsOf(ctx, viewer, roomId);

    if (memberships.length > 0) {
      return (await membersMaySee(ctx, viewer, memberships, title))
        ? presentRoom(ctx, found)
        : fail("not_found", "No such room");
    }

    if (profileId === undefined) return fail("not_found", "No such room");
    const audience = await loadAudience(ctx, viewer, profileId);

    if (!canSee(audience, title)) return fail("not_found", "No such room");

    return { ...(await presentRoom(ctx, found)), members: [] };
  },
});

export const current = query({
  args: { deviceId: v.string() },
  returns: v.union(v.null(), roomResult),
  handler: async (ctx, { deviceId }) => {
    const viewer = await authorize(ctx, "read");

    const memberships = await ctx.db
      .query("roomMembers")
      .withIndex("by_user_device", (q) => q.eq("userId", viewer.userId).eq("deviceId", deviceId))
      .collect();

    const rooms = await Promise.all(memberships.map((member) => ctx.db.get(member.roomId)));
    const live = rooms.find((doc) => doc !== null && doc.status !== "ended");

    return live === undefined || live === null ? null : presentRoom(ctx, live);
  },
});

export const join = mutation({
  args: { roomId: v.id("rooms"), profileId: v.id("profiles"), deviceId: v.string() },
  returns: roomResult,
  handler: async (ctx, { roomId, profileId, deviceId }) => {
    const viewer = await authorize(ctx, "play");
    checkDeviceId(deviceId);
    const found = await loadRoom(ctx, roomId);

    if (found.status === "ended") return fail("conflict", "This room has ended");
    const audience = await loadAudience(ctx, viewer, profileId);
    await loadVisibleTitle(ctx, audience, found.titleId);
    const now = Date.now();

    const existing = await ctx.db
      .query("roomMembers")
      .withIndex("by_room_device", (q) => q.eq("roomId", roomId).eq("deviceId", deviceId))
      .unique();

    if (existing !== null && existing.userId !== viewer.userId) {
      return fail("conflict", "Another account is using this device ID in the room");
    }

    if (existing === null) {
      await ctx.db.insert("roomMembers", {
        roomId,
        userId: viewer.userId,
        profileId,
        deviceId,
        role: "guest",
        joinedAt: now,
        lastSeenAt: now,
      });
    } else {
      await ctx.db.patch(existing._id, { profileId, lastSeenAt: now });
    }

    return presentRoom(ctx, await loadRoom(ctx, roomId));
  },
});

const endRoom = async (ctx: MutationCtx, doc: Doc<"rooms">): Promise<void> => {
  const now = Date.now();

  await ctx.db.patch(doc._id, {
    status: "ended",
    positionAtAnchorMs: livePosition(doc, now),
    anchorServerTime: now,
    revision: doc.revision + 1,
    endedAt: now,
  });
};

/** Leaves the room. A guest leaving changes nothing else; the host leaving ends the room. */
export const leave = mutation({
  args: { roomId: v.id("rooms"), deviceId: v.string() },
  returns: ok,
  handler: async (ctx, { roomId, deviceId }) => {
    const viewer = await authorize(ctx, "play");
    const found = await loadRoom(ctx, roomId);

    const member = await ctx.db
      .query("roomMembers")
      .withIndex("by_room_device", (q) => q.eq("roomId", roomId).eq("deviceId", deviceId))
      .unique();

    if (member?.userId !== viewer.userId) return { ok: true as const };
    await ctx.db.delete(member._id);

    if (member.role === "host" && found.status !== "ended") await endRoom(ctx, found);

    return { ok: true as const };
  },
});

export const play = mutation({
  args: hostControlArgs,
  returns: roomClock,
  handler: (ctx, args) =>
    hostCommand(ctx, args, (_room, now) => ({
      status: "playing",
      positionAtAnchorMs: checkPosition(args.positionMs),
      anchorServerTime: now,
    })),
});

export const pause = mutation({
  args: hostControlArgs,
  returns: roomClock,
  handler: (ctx, args) =>
    hostCommand(ctx, args, (_room, now) => ({
      status: "paused",
      positionAtAnchorMs: checkPosition(args.positionMs),
      anchorServerTime: now,
    })),
});

export const seek = mutation({
  args: hostControlArgs,
  returns: roomClock,
  handler: (ctx, args) =>
    hostCommand(ctx, args, (room, now) => ({
      status: room.status === "buffering" ? "paused" : room.status,
      positionAtAnchorMs: checkPosition(args.positionMs),
      anchorServerTime: now,
    })),
});

export const buffering = mutation({
  args: hostControlArgs,
  returns: roomClock,
  handler: (ctx, args) =>
    hostCommand(ctx, args, (_room, now) => ({
      status: "buffering",
      positionAtAnchorMs: checkPosition(args.positionMs),
      anchorServerTime: now,
    })),
});

/**
 * Keeps the device's membership alive. A guest's heartbeat records its reported drift for the room
 * to show. The host's heartbeat also clears `hostAway` and, when the host's player drifted from
 * the computed position and the host saw the current revision, re-anchors the clock at the host's
 * position.
 */
export const heartbeat = mutation({
  args: {
    roomId: v.id("rooms"),
    deviceId: v.string(),
    positionMs: v.optional(v.number()),
    revision: v.optional(v.number()),
    driftMs: v.optional(v.number()),
  },
  returns: roomClock,
  handler: async (ctx, { roomId, deviceId, positionMs, revision, driftMs }) => {
    const viewer = await authorize(ctx, "play");
    const found = await loadRoom(ctx, roomId);

    const member = await ctx.db
      .query("roomMembers")
      .withIndex("by_room_device", (q) => q.eq("roomId", roomId).eq("deviceId", deviceId))
      .unique();

    if (member?.userId !== viewer.userId)
      return fail("forbidden", "Join the room on this device first");
    const now = Date.now();

    if (member.role === "guest") {
      // A guest that stopped reporting drift (buffering) clears the last value it reported.
      await ctx.db.patch(member._id, {
        lastSeenAt: now,
        driftMs: Number.isFinite(driftMs) ? driftMs : undefined,
      });
    } else {
      await ctx.db.patch(member._id, { lastSeenAt: now });
    }

    if (member.role !== "host" || found.status === "ended") return presentRoomClock(found);

    const drifted =
      positionMs !== undefined &&
      revision === found.revision &&
      found.status === "playing" &&
      Math.abs(positionMs - livePosition(found, now)) > HOST_REANCHOR_THRESHOLD_MS;

    await ctx.db.patch(
      found._id,
      drifted
        ? {
            hostLastSeenAt: now,
            hostAway: false,
            positionAtAnchorMs: checkPosition(positionMs),
            anchorServerTime: now,
            revision: found.revision + 1,
          }
        : { hostLastSeenAt: now, hostAway: false },
    );

    return presentRoomClock(await loadRoom(ctx, roomId));
  },
});

/** Switches the room to another movie or episode, paused at its start. Host only. */
export const setMedia = mutation({
  args: {
    roomId: v.id("rooms"),
    deviceId: v.string(),
    revision: v.number(),
    titleId: v.id("titles"),
    episodeId: v.optional(v.id("episodes")),
    fileId: v.optional(v.id("mediaFiles")),
  },
  returns: roomClock,
  handler: async (ctx, args) => {
    const viewer = await authorize(ctx, "play");
    const found = await loadRoom(ctx, args.roomId);

    if (found.hostUserId !== viewer.userId) {
      return fail("forbidden", "Only the host's device controls the room");
    }

    const audience = await loadAudience(ctx, viewer, found.hostProfileId);
    const title = await loadVisibleTitle(ctx, audience, args.titleId);

    const playable = await resolvePlayable(ctx, title, args.episodeId ?? null, args.fileId ?? null);

    return hostCommand(ctx, args, (_room, now) => ({
      titleId: title._id,
      episodeId: playable.episode?._id ?? null,
      fileId: playable.file._id,
      status: "paused",
      positionAtAnchorMs: 0,
      anchorServerTime: now,
    }));
  },
});

export const end = mutation({
  args: { roomId: v.id("rooms"), deviceId: v.string() },
  returns: ok,
  handler: async (ctx, { roomId, deviceId }) => {
    const viewer = await authorize(ctx, "play");
    const found = await loadRoom(ctx, roomId);

    if (found.hostUserId !== viewer.userId || found.hostDeviceId !== deviceId) {
      return fail("forbidden", "Only the host's device can end the room");
    }

    if (found.status !== "ended") await endRoom(ctx, found);

    return { ok: true as const };
  },
});

/** The server clock, for estimating a device's offset. A mutation, so no result is cached. */
export const time = mutation({
  args: {},
  returns: v.object({ serverTime: v.number() }),
  handler: async (ctx) => {
    await authorize(ctx, "play");

    return { serverTime: Date.now() };
  },
});
