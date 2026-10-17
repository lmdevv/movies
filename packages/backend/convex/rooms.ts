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
import {
  canSee,
  isProfileUnlocked,
  loadAudience,
  loadVisibleTitle,
  visibleLibraryIds,
} from "./lib/access";
import { checkDeviceId, checkMilliseconds } from "./lib/bounds";
import { endRoom, leaveRoom } from "./lib/endings";
import { fail } from "./lib/errors";
import { BEST_QUALITY, resolveEpisode, resolvePlayable } from "./lib/playable";
import { createdAt, presentEpisode, presentRoomClock, presentTitleCard } from "./lib/present";
import { awayHostClock, hostReading, livePosition, PLAYER_SILENCE_MS } from "./lib/roomClock";
import { hostControlArgs, ok, room as roomResult, roomClock, roomPresence } from "./lib/validators";
import type { Viewer } from "./lib/viewer";
import { authorize } from "./lib/viewer";

type RoomPatch = Partial<
  Pick<
    Doc<"rooms">,
    | "status"
    | "positionAtAnchorMs"
    | "anchorServerTime"
    | "titleId"
    | "episodeId"
    | "fileId"
    | "fileDurationMs"
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
      presence: member.presence ?? "watching",
      // A counted away heartbeat clears the drift, so an away member has none.
      driftMs: member.role === "guest" ? (member.driftMs ?? null) : null,
    })),
    createdAt: createdAt(doc),
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
 * Whether one of the profiles the viewer joined with, unlocked on this session, may still see the
 * room's title: the host can switch the room to a title a guest's profile may not see, and then
 * that guest stops seeing it.
 */
const membersMaySee = async (
  ctx: QueryCtx,
  viewer: Viewer,
  memberships: ReadonlyArray<Doc<"roomMembers">>,
  title: Doc<"titles">,
): Promise<boolean> => {
  const libraryIds = await visibleLibraryIds(ctx, viewer);
  const profiles = await Promise.all(memberships.map((member) => ctx.db.get(member.profileId)));

  // A profile joined on another session may have a PIN this session has not entered.
  return profiles.some(
    (profile) =>
      profile !== null &&
      isProfileUnlocked(viewer, profile) &&
      canSee({ viewer, profile, libraryIds }, title),
  );
};

/** Whether the viewer, as a member, may read the room: see `membersMaySee`. */
const memberMayRead = async (
  ctx: QueryCtx,
  viewer: Viewer,
  room: Doc<"rooms">,
): Promise<boolean> => {
  const title = await ctx.db.get(room.titleId);

  return (
    title !== null && membersMaySee(ctx, viewer, await membershipsOf(ctx, viewer, room._id), title)
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

/**
 * Keeps a device in one room at a time: before it hosts or joins a room, it leaves every other room
 * it is in, ending the ones it hosts.
 */
const leaveOtherRooms = async (
  ctx: MutationCtx,
  viewer: Viewer,
  deviceId: string,
  keep: Id<"rooms"> | null,
  now: number,
): Promise<void> => {
  const memberships = await ctx.db
    .query("roomMembers")
    .withIndex("by_user_device", (q) => q.eq("userId", viewer.userId).eq("deviceId", deviceId))
    .collect();

  await Promise.all(
    memberships.flatMap((member) => (member.roomId === keep ? [] : [leaveRoom(ctx, member, now)])),
  );
};

/**
 * Opens a watch room hosted by this device, paused at `positionMs` on the title's file. Requires
 * `play` scope. The device first leaves every other room it is in, ending the ones it hosts.
 */
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

    const playable = await resolvePlayable(
      ctx,
      title,
      await resolveEpisode(ctx, title, args.episodeId ?? null),
      args.fileId ?? null,
      BEST_QUALITY,
    );

    const now = Date.now();

    await leaveOtherRooms(ctx, viewer, args.deviceId, null, now);

    const roomId = await ctx.db.insert("rooms", {
      titleId: title._id,
      episodeId: playable.episode?._id ?? null,
      fileId: playable.file._id,
      fileDurationMs: playable.file.probe.durationMs,
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
      presence: "watching",
      watchedAt: now,
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

    // Any profile that cannot be used here (another account's, or PIN-locked on this session)
    // answers as a missing room does, so the reply never tells whether the room exists.
    const profile = profileId === undefined ? null : await ctx.db.get(profileId);

    if (profile?.userId !== viewer.userId || !isProfileUnlocked(viewer, profile)) {
      return fail("not_found", "No such room");
    }

    const libraryIds = await visibleLibraryIds(ctx, viewer);

    if (!canSee({ viewer, profile, libraryIds }, title)) return fail("not_found", "No such room");

    return { ...(await presentRoom(ctx, found)), members: [] };
  },
});

/**
 * The live room this device is in, or null. Also null when no profile it joined with, unlocked on
 * this session, may still see the room's title.
 */
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

    // Read only as `rooms.get` would allow: a joined profile still unlocked that may see the title.
    return live === undefined || live === null || !(await memberMayRead(ctx, viewer, live))
      ? null
      : presentRoom(ctx, live);
  },
});

/**
 * Joins a live room as a guest on this device, or updates the profile of a device already in it.
 * Requires `play` scope and a profile that may see the title. The device leaves its other rooms,
 * ending the ones it hosts; an ended room fails with `conflict`.
 */
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

    await leaveOtherRooms(ctx, viewer, deviceId, roomId, now);

    if (existing === null) {
      await ctx.db.insert("roomMembers", {
        roomId,
        userId: viewer.userId,
        profileId,
        deviceId,
        role: "guest",
        joinedAt: now,
        lastSeenAt: now,
        presence: "watching",
        watchedAt: now,
      });
    } else {
      // Joining is opening the room's player, so a device that was browsing is watching again.
      await ctx.db.patch(existing._id, {
        profileId,
        lastSeenAt: now,
        presence: "watching",
        watchedAt: now,
      });
    }

    return presentRoom(ctx, await loadRoom(ctx, roomId));
  },
});

/** Leaves the room. A guest leaving changes nothing else; the host leaving ends the room. */
export const leave = mutation({
  args: { roomId: v.id("rooms"), deviceId: v.string() },
  returns: ok,
  handler: async (ctx, { roomId, deviceId }) => {
    const viewer = await authorize(ctx, "play");
    // A missing room fails with not_found, as for every room command.
    await loadRoom(ctx, roomId);

    const member = await ctx.db
      .query("roomMembers")
      .withIndex("by_room_device", (q) => q.eq("roomId", roomId).eq("deviceId", deviceId))
      .unique();

    if (member?.userId !== viewer.userId) return { ok: true as const };
    await leaveRoom(ctx, member, Date.now());

    return { ok: true as const };
  },
});

/**
 * Plays the room from `positionMs`. Host's device only, at the room's current revision, or it fails
 * with `stale_revision`.
 */
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

/** Pauses the room at `positionMs`. Host's device only, at the room's current revision. */
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

/**
 * Moves the room to `positionMs`, keeping it playing or paused; a buffering room comes out paused.
 * Host's device only, at the room's current revision.
 */
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

/**
 * Freezes the room at `positionMs` while the host buffers; guests wait until the host plays again.
 * Host's device only, at the room's current revision.
 */
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
 * Keeps the device's membership alive and records its `presence`: `watching` (the default) from
 * the room's player, `away` from a device browsing elsewhere in the app, which keeps its place
 * without counting as watching. An away heartbeat while the device's player reported within
 * `PLAYER_SILENCE_MS` (another tab, or a heartbeat sent just before the player opened) only keeps
 * the place. A watching guest's heartbeat records its reported drift for the
 * room to show; an away one clears it. The host's heartbeat also clears `hostAway`, as an away
 * host is still there. A watching host's heartbeat re-anchors the clock at the host's position,
 * carried forward from when the host read it, when the host's player drifted from the computed
 * position and the host saw the current revision. An away host has no player to drift: the room
 * plays on, except that one frozen for the host's buffering, or played past the end of its file,
 * pauses (`awayHostClock`).
 */
export const heartbeat = mutation({
  args: {
    roomId: v.id("rooms"),
    deviceId: v.string(),
    positionMs: v.optional(v.number()),
    atServerTime: v.optional(v.number()),
    revision: v.optional(v.number()),
    driftMs: v.optional(v.number()),
    presence: v.optional(roomPresence),
  },
  returns: roomClock,
  handler: async (
    ctx,
    { roomId, deviceId, positionMs, atServerTime, revision, driftMs, presence = "watching" },
  ) => {
    const viewer = await authorize(ctx, "play");
    const found = await loadRoom(ctx, roomId);

    const member = await ctx.db
      .query("roomMembers")
      .withIndex("by_room_device", (q) => q.eq("roomId", roomId).eq("deviceId", deviceId))
      .unique();

    if (member?.userId !== viewer.userId)
      return fail("forbidden", "Join the room on this device first");
    const now = Date.now();
    const away = presence === "away";
    // A row from before `watchedAt` heard only from its player: its last heartbeat is the player's.
    const watchedAt = member.watchedAt ?? member.lastSeenAt;
    const playerReported = now - watchedAt < PLAYER_SILENCE_MS;

    if (away && playerReported) {
      // The device's player reports for it, keeping its place: nothing to write but a legacy
      // row's last player report, so later away heartbeats cannot move it forward.
      if (member.watchedAt === undefined) await ctx.db.patch(member._id, { watchedAt });

      return presentRoomClock(found);
    }

    if (away) {
      // Away clears any drift the device reported: it plays nothing.
      await ctx.db.patch(member._id, {
        lastSeenAt: now,
        presence: "away",
        driftMs: undefined,
        watchedAt,
      });
    } else {
      // A guest that stopped reporting drift (buffering) clears the last value it reported.
      await ctx.db.patch(member._id, {
        lastSeenAt: now,
        presence: "watching",
        watchedAt: now,
        driftMs: member.role === "guest" && Number.isFinite(driftMs) ? driftMs : undefined,
      });
    }

    if (member.role !== "host" || found.status === "ended") return presentRoomClock(found);

    if (away) {
      // Rooms from before `fileDurationMs` read their file's length, only while playing.
      const durationMs =
        found.fileDurationMs ??
        (found.status === "playing"
          ? ((await ctx.db.get(found.fileId))?.probe.durationMs ?? 0)
          : 0);

      const paused = awayHostClock(found, durationMs, now);

      await ctx.db.patch(
        found._id,
        paused === null
          ? { hostLastSeenAt: now, hostAway: false }
          : { ...paused, revision: found.revision + 1, hostLastSeenAt: now, hostAway: false },
      );

      return presentRoomClock(await loadRoom(ctx, roomId));
    }

    const readAt =
      atServerTime === undefined ? undefined : checkMilliseconds(atServerTime, "Server times");

    const reading =
      positionMs === undefined || revision !== found.revision || found.status !== "playing"
        ? undefined
        : hostReading(found, positionMs, readAt, now);

    const drifted =
      reading !== undefined &&
      Math.abs(reading.positionMs - livePosition(found, now)) > reading.thresholdMs;

    await ctx.db.patch(
      found._id,
      drifted
        ? {
            hostLastSeenAt: now,
            hostAway: false,
            positionAtAnchorMs: checkPosition(reading.positionMs),
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

    const playable = await resolvePlayable(
      ctx,
      title,
      await resolveEpisode(ctx, title, args.episodeId ?? null),
      args.fileId ?? null,
      BEST_QUALITY,
    );

    return hostCommand(ctx, args, (_room, now) => ({
      titleId: title._id,
      episodeId: playable.episode?._id ?? null,
      fileId: playable.file._id,
      fileDurationMs: playable.file.probe.durationMs,
      status: "paused",
      positionAtAnchorMs: 0,
      anchorServerTime: now,
    }));
  },
});

/**
 * Ends the room for every member at its live position. Host's device only; ending an ended room is
 * harmless.
 */
export const end = mutation({
  args: { roomId: v.id("rooms"), deviceId: v.string() },
  returns: ok,
  handler: async (ctx, { roomId, deviceId }) => {
    const viewer = await authorize(ctx, "play");
    const found = await loadRoom(ctx, roomId);

    if (found.hostUserId !== viewer.userId || found.hostDeviceId !== deviceId) {
      return fail("forbidden", "Only the host's device can end the room");
    }

    if (found.status !== "ended") await endRoom(ctx, found, Date.now());

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
