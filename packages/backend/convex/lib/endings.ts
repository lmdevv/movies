/**
 * Ending playback sessions and watch rooms. Every path that ends one (sign-out, idle sweeps, a new
 * session on the device, a removed library, the host leaving) goes through these, so the fields
 * an ended record carries stay the same everywhere.
 */
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
