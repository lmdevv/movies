import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { livePosition } from "./roomClock";

/** Ends a playback session; the media service stops its streams when it sees it ended. */
export const endPlaybackSession = (
  ctx: MutationCtx,
  session: Doc<"playbackSessions">,
  now: number,
): Promise<void> => ctx.db.patch(session._id, { status: "ended", state: "paused", endedAt: now });

/** Ends a room at its live position, at the next revision so members see the change. */
export const endRoom = (ctx: MutationCtx, room: Doc<"rooms">, now: number): Promise<void> =>
  ctx.db.patch(room._id, {
    status: "ended",
    positionAtAnchorMs: livePosition(room, now),
    anchorServerTime: now,
    revision: room.revision + 1,
    endedAt: now,
  });

/** Ends the active playback sessions and live rooms of one title, through their title indexes. */
export const endTitlePlayback = async (
  ctx: MutationCtx,
  titleId: Id<"titles">,
  now: number,
): Promise<void> => {
  const sessions = await ctx.db
    .query("playbackSessions")
    .withIndex("by_title_status", (q) => q.eq("titleId", titleId).eq("status", "active"))
    .collect();

  const rooms = await Promise.all(
    (["playing", "buffering", "paused"] as const).map((status) =>
      ctx.db
        .query("rooms")
        .withIndex("by_title_status", (q) => q.eq("titleId", titleId).eq("status", status))
        .collect(),
    ),
  );

  await Promise.all([
    ...sessions.map((session) => endPlaybackSession(ctx, session, now)),
    ...rooms.flat().map((room) => endRoom(ctx, room, now)),
  ]);
};

/** Takes a member out of its room; a host leaving ends the room. */
export const leaveRoom = async (
  ctx: MutationCtx,
  member: Doc<"roomMembers">,
  now: number,
): Promise<void> => {
  const room = member.role === "host" ? await ctx.db.get(member.roomId) : null;

  if (room !== null && room.status !== "ended") await endRoom(ctx, room, now);

  await ctx.db.delete(member._id);
};

/**
 * Ends what a profile that is going away is doing: its active playback sessions, so a device still
 * playing records no progress for it, and its room memberships, ending the rooms it hosts, even
 * where the host's device has since joined with another profile.
 */
export const endProfilePlayback = async (
  ctx: MutationCtx,
  profile: Doc<"profiles">,
  now: number,
): Promise<void> => {
  const sessions = await ctx.db
    .query("playbackSessions")
    .withIndex("by_user_status", (q) => q.eq("userId", profile.userId).eq("status", "active"))
    .collect();

  const memberships = await ctx.db
    .query("roomMembers")
    .withIndex("by_user_device", (q) => q.eq("userId", profile.userId))
    .collect();

  const hosted = await Promise.all(
    memberships.map(
      async (member) =>
        member.role === "host" && (await ctx.db.get(member.roomId))?.hostProfileId === profile._id,
    ),
  );

  await Promise.all([
    ...sessions.flatMap((session) =>
      session.profileId === profile._id ? [endPlaybackSession(ctx, session, now)] : [],
    ),
    ...memberships.flatMap((member, index) =>
      member.profileId === profile._id || hosted[index] === true
        ? [leaveRoom(ctx, member, now)]
        : [],
    ),
  ]);
};
