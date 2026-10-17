/**
 * Watch rooms: a stored, anchored clock that members follow with their own streams. Only the
 * host's device changes the clock, and every change carries the revision the host last saw; an
 * older revision fails with `stale_revision`. Guests only join, heartbeat, and leave.
 *
 * Moving on to the next episode is the host's too. Near the end of an episode the host's player
 * starts a countdown the room stores (`next`), so every member counts down to the same server time;
 * a function scheduled for that time moves the room on, also when the host has gone. Those commands
 * are keyed on the episode the room plays rather than the clock's revision: whichever of the
 * countdown, the host's Play next, or a repeat comes first moves the room on, and the rest find it
 * already moved and change nothing.
 */
import { v } from "convex/values";
import type { Infer } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { internalMutation, mutation, query } from "./_generated/server";
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
import type { Playable } from "./lib/playable";
import { BEST_QUALITY, filesOnDisk, resolveEpisode, resolvePlayable } from "./lib/playable";
import { createdAt, presentEpisode, presentRoomClock, presentTitleCard } from "./lib/present";
import {
  AWAY_REFRESH_MS,
  awayHostClock,
  hostReading,
  livePosition,
  NEXT_EPISODE_COUNTDOWN_MS,
  PLAYER_SILENCE_MS,
} from "./lib/roomClock";
import { hostControlArgs, ok, room as roomResult, roomClock, roomPresence } from "./lib/validators";
import { nextEpisodeAfter } from "./lib/viewing";
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
> & {
  /** Undefined removes the room's countdown, as a change of media does. */
  next?: Doc<"rooms">["next"] | undefined;
};

/** What an away host's heartbeat writes to its room. */
type AwayHostPatch = RoomPatch &
  Partial<Pick<Doc<"rooms">, "hostLastSeenAt" | "hostAway" | "revision">>;

const loadRoom = async (ctx: QueryCtx, roomId: Id<"rooms">): Promise<Doc<"rooms">> => {
  const found = await ctx.db.get(roomId);

  if (found === null) return fail("not_found", "No such room");

  return found;
};

/**
 * The room's next-episode countdown as members see it: the episode it moves on to, without any
 * profile's progress, as for the room's own episode. A pending countdown whose episode is gone has
 * nothing to show.
 */
const presentNext = async (
  ctx: QueryCtx,
  doc: Doc<"rooms">,
): Promise<Infer<typeof roomResult>["next"]> => {
  if (doc.next === undefined) return null;

  if (doc.next.status === "cancelled") return { status: "cancelled" };
  const target = await ctx.db.get(doc.next.episodeId);

  return target === null
    ? null
    : { status: "pending", episode: presentEpisode(target, null), nextAt: doc.next.nextAt };
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
  const next = await presentNext(ctx, doc);

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
    next,
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
 * The live room `args.roomId` for a command from its host's account and device; anyone else fails
 * with `forbidden`, and an ended room with `conflict`.
 */
const loadHostRoom = async (
  ctx: MutationCtx,
  args: { roomId: Id<"rooms">; deviceId: string },
): Promise<{ readonly viewer: Viewer; readonly room: Doc<"rooms"> }> => {
  const viewer = await authorize(ctx, "play");
  const room = await loadRoom(ctx, args.roomId);

  if (room.status === "ended") return fail("conflict", "This room has ended");

  if (room.hostUserId !== viewer.userId || room.hostDeviceId !== args.deviceId) {
    return fail("forbidden", "Only the host's device controls the room");
  }

  return { viewer, room };
};

/**
 * Applies a host command: requires the host's account and device, a live room, and the room's
 * current revision, then writes the change with the next revision.
 */
const hostCommand = async (
  ctx: MutationCtx,
  args: {
    roomId: Id<"rooms">;
    deviceId: string;
    revision: number;
    fileId?: Id<"mediaFiles"> | undefined;
  },
  change: (current: Doc<"rooms">, now: number) => RoomPatch,
): Promise<Infer<typeof roomClock>> => {
  const { room: current } = await loadHostRoom(ctx, args);

  // A player still on the file the room moved on from must not move the new one's clock.
  if (args.revision !== current.revision || (args.fileId ?? current.fileId) !== current.fileId) {
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
 * the place. A watching guest's heartbeat records its reported drift for the room to show; an
 * away one clears it. Any host heartbeat keeps a live room from being marked `hostAway`; only a
 * watching one clears the mark, as the room stays paused for its guests until the host's player
 * is back. A watching host's heartbeat re-anchors the clock at the host's position, carried
 * forward from when the host read it, when the host's player drifted from the computed position,
 * the host saw the current revision, and its player plays the room's file. An away host has no
 * player to drift: the room plays on, except that one frozen for the host's buffering, or played
 * past the end of its file, pauses (`awayHostClock`).
 */
export const heartbeat = mutation({
  args: {
    roomId: v.id("rooms"),
    deviceId: v.string(),
    positionMs: v.optional(v.number()),
    atServerTime: v.optional(v.number()),
    revision: v.optional(v.number()),
    fileId: v.optional(v.id("mediaFiles")),
    driftMs: v.optional(v.number()),
    presence: v.optional(roomPresence),
  },
  returns: roomClock,
  handler: async (
    ctx,
    {
      roomId,
      deviceId,
      positionMs,
      atServerTime,
      revision,
      fileId,
      driftMs,
      presence = "watching",
    },
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
      // Away clears any drift the device reported: it plays nothing. An away member's place is
      // refreshed only every `AWAY_REFRESH_MS`, well inside the member timeout, so browsing
      // members do not re-run the room's subscriptions on every heartbeat.
      if (member.presence !== "away" || now - member.lastSeenAt >= AWAY_REFRESH_MS) {
        await ctx.db.patch(member._id, {
          lastSeenAt: now,
          presence: "away",
          driftMs: undefined,
          watchedAt,
        });
      }
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
      // A room from before `fileDurationMs` reads its file's length once, while playing, and
      // keeps it.
      const reading = found.fileDurationMs === undefined && found.status === "playing";
      const read = reading ? await ctx.db.get(found.fileId) : null;
      // A missing file keeps 0, a length `awayHostClock` treats as unknown, so it is read once.
      const durationMs = found.fileDurationMs ?? read?.probe.durationMs ?? 0;
      const paused = awayHostClock(found, durationMs, now);
      // An away host keeps a live room from being marked away; one the sweep already marked stays
      // so for its guests until the host's player is back.
      const patch: AwayHostPatch = { hostLastSeenAt: now };

      if (reading) patch.fileDurationMs = durationMs;

      if (paused !== null) {
        patch.status = paused.status;
        patch.positionAtAnchorMs = paused.positionAtAnchorMs;
        patch.anchorServerTime = paused.anchorServerTime;
        patch.revision = found.revision + 1;
      }

      // The host's presence too is refreshed only every `AWAY_REFRESH_MS`, inside the host timeout.
      const quiet = paused === null && !reading && now - found.hostLastSeenAt < AWAY_REFRESH_MS;

      if (quiet) return presentRoomClock(found);

      await ctx.db.patch(found._id, patch);

      return presentRoomClock(await loadRoom(ctx, roomId));
    }

    const readAt =
      atServerTime === undefined ? undefined : checkMilliseconds(atServerTime, "Server times");

    // A position read on a file the room moved on from says nothing about the new one.
    const reading =
      positionMs === undefined ||
      revision !== found.revision ||
      found.status !== "playing" ||
      (fileId ?? found.fileId) !== found.fileId
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

    return hostCommand(ctx, args, (_room, now) => mediaChange(playable, now));
  },
});

/**
 * Switching a room to `playable`: paused at its start until the host's player plays it, and
 * without the old media's countdown. Members' players see the new media and open it, each with a
 * stream and progress of its own; those slower to load join at the live position.
 */
const mediaChange = (playable: Playable, now: number): RoomPatch => ({
  titleId: playable.title._id,
  episodeId: playable.episode?._id ?? null,
  fileId: playable.file._id,
  fileDurationMs: playable.file.probe.durationMs,
  status: "paused",
  positionAtAnchorMs: 0,
  anchorServerTime: now,
  next: undefined,
});

/** Why a room cannot move on to its next episode. */
type NextProblem = "movie" | "last_episode" | "missing_file";

/**
 * The episode after the one `room` plays, with the file it would play, or why there is none: a
 * movie, the last episode (specials last), or an episode with no file on disk. Its title is the
 * room's, so every member who may watch this episode may watch the next.
 */
const nextPlayable = async (ctx: QueryCtx, room: Doc<"rooms">): Promise<Playable | NextProblem> => {
  const playing = room.episodeId === null ? null : await ctx.db.get(room.episodeId);
  const title = await ctx.db.get(room.titleId);

  if (playing === null || title === null) return "movie";
  const episode = await nextEpisodeAfter(ctx, playing);

  if (episode === null) return "last_episode";
  const [file] = await filesOnDisk(ctx, title, episode);

  return file === undefined ? "missing_file" : { title, episode, file };
};

/**
 * What the room's pending countdown moves on to: the episode it named, with a file on disk. Null
 * when there is no pending countdown, or its episode has since gone or lost its files.
 */
const pendingPlayable = async (ctx: QueryCtx, room: Doc<"rooms">): Promise<Playable | null> => {
  if (room.next?.status !== "pending") return null;
  const episode = await ctx.db.get(room.next.episodeId);
  const title = await ctx.db.get(room.titleId);

  if (episode?.titleId !== room.titleId || title === null) return null;
  const [file] = await filesOnDisk(ctx, title, episode);

  return file === undefined ? null : { title, episode, file };
};

/** `nextPlayable` for a host's command, failing when there is no next episode to move on to. */
const requireNextPlayable = async (ctx: QueryCtx, room: Doc<"rooms">): Promise<Playable> => {
  const found = await nextPlayable(ctx, room);

  if (found === "movie") return fail("invalid_args", "A movie has no next episode");

  if (found === "last_episode") return fail("not_found", "This is the show's last episode");

  if (found === "missing_file") {
    return fail("conflict", "The next episode's file is missing from disk");
  }

  return found;
};

/**
 * Moves `room` on to `playable` with the next revision. The countdown's scheduled function goes
 * through here without a host, so it never checks one.
 */
const moveOn = async (
  ctx: MutationCtx,
  room: Doc<"rooms">,
  playable: Playable,
  now: number,
): Promise<void> => {
  await ctx.db.patch(room._id, { ...mediaChange(playable, now), revision: room.revision + 1 });
};

/**
 * The arguments of the next-episode commands: the room, the host's device, and the episode the
 * host moves on from. A command for an episode the room no longer plays changes nothing, so
 * repeats, races with the countdown, and stale tabs act once, on the episode they meant.
 */
const fromEpisodeArgs = {
  roomId: v.id("rooms"),
  deviceId: v.string(),
  fromEpisodeId: v.id("episodes"),
};

/**
 * Starts the room's countdown to its next episode: at `NEXT_EPISODE_COUNTDOWN_MS` from now by the
 * server's clock, a scheduled function moves the whole room on, whether or not the host is still
 * there. Host's device only, from the episode the room plays. A countdown already running, or one
 * the host cancelled, stays as it is, so a repeat or a reload never restarts it, and a call from
 * an episode the room moved on from changes nothing. Fails with `not_found` after the last episode,
 * `conflict` when the next episode's file is missing, and `invalid_args` for a movie.
 */
export const startNextCountdown = mutation({
  args: fromEpisodeArgs,
  returns: roomResult,
  handler: async (ctx, args) => {
    const { viewer, room } = await loadHostRoom(ctx, args);
    // The host profile still sees the room's title, as `setMedia` asks of what it plays.
    await loadVisibleTitle(ctx, await loadAudience(ctx, viewer, room.hostProfileId), room.titleId);

    if (room.episodeId === null) return fail("invalid_args", "A movie has no next episode");

    // A room that moved on, or already counts down or was cancelled, stays as it is.
    if (room.episodeId !== args.fromEpisodeId || room.next !== undefined) {
      return presentRoom(ctx, room);
    }

    const target = await requireNextPlayable(ctx, room);

    if (target.episode === null) return fail("invalid_args", "A movie has no next episode");
    const nextAt = Date.now() + NEXT_EPISODE_COUNTDOWN_MS;

    await ctx.db.patch(room._id, {
      next: { status: "pending", episodeId: target.episode._id, nextAt },
    });
    await ctx.scheduler.runAt(nextAt, internal.rooms.nextEpisodeDue, {
      roomId: room._id,
      fromEpisodeId: room.episodeId,
      nextAt,
    });

    return presentRoom(ctx, await loadRoom(ctx, room._id));
  },
});

/**
 * Cancels the room's next-episode countdown for every member, so this episode plays out to the end
 * of its credits; a countdown can then not start again for it, though the host can still play the
 * next episode. Host's device only; cancelling twice is harmless.
 */
export const cancelNextCountdown = mutation({
  args: fromEpisodeArgs,
  returns: roomResult,
  handler: async (ctx, args) => {
    const { room } = await loadHostRoom(ctx, args);

    // A cancel meant for an episode the room moved on from leaves the new one's countdown alone.
    if (room.episodeId === args.fromEpisodeId && room.next?.status !== "cancelled") {
      await ctx.db.patch(room._id, { next: { status: "cancelled" } });
    }

    return presentRoom(ctx, await loadRoom(ctx, room._id));
  },
});

/**
 * Moves the room on from `fromEpisodeId` to the next episode now: the one its countdown names, or
 * the episode after. Host's device only. When the room already plays another episode it moved on
 * before this call, which changes nothing, so a repeated click or one racing the countdown moves it
 * on once. Fails as `startNextCountdown` does when there is no next episode to play.
 */
export const playNext = mutation({
  args: fromEpisodeArgs,
  returns: roomResult,
  handler: async (ctx, args) => {
    const { viewer, room } = await loadHostRoom(ctx, args);

    if (room.episodeId !== args.fromEpisodeId) return presentRoom(ctx, room);
    await loadVisibleTitle(ctx, await loadAudience(ctx, viewer, room.hostProfileId), room.titleId);

    // The episode the countdown showed everyone, while it can play; otherwise the one after.
    const playable = (await pendingPlayable(ctx, room)) ?? (await requireNextPlayable(ctx, room));

    await moveOn(ctx, room, playable, Date.now());

    return presentRoom(ctx, await loadRoom(ctx, room._id));
  },
});

/**
 * The end of a countdown `startNextCountdown` scheduled: moves the room on from `fromEpisodeId`
 * when it still plays it with that countdown pending. A room that moved on, ended, or whose host
 * cancelled is left alone, so the function changes a room at most once. When the episode the
 * countdown named is gone or lost its files meanwhile, the countdown is cancelled instead, which
 * takes the card away for everyone.
 */
export const nextEpisodeDue = internalMutation({
  args: { roomId: v.id("rooms"), fromEpisodeId: v.id("episodes"), nextAt: v.number() },
  returns: v.null(),
  handler: async (ctx, { roomId, fromEpisodeId, nextAt }) => {
    const room = await ctx.db.get(roomId);

    if (
      room === null ||
      room.status === "ended" ||
      room.episodeId !== fromEpisodeId ||
      room.next?.status !== "pending" ||
      room.next.nextAt !== nextAt
    ) {
      return null;
    }

    const target = await pendingPlayable(ctx, room);

    if (target === null) {
      await ctx.db.patch(room._id, { next: { status: "cancelled" } });

      return null;
    }

    await moveOn(ctx, room, target, Date.now());

    return null;
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
