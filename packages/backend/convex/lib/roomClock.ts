/**
 * Room clock rules on the server. The constants equal those in `@movies/contracts/clock`; the
 * backend tests compare them.
 */
import type { Doc } from "../_generated/dataModel";

/** A host silent this long is away and the room pauses. */
export const HOST_PRESENCE_TIMEOUT_MS = 20_000;

/** A guest silent this long leaves the member list. */
export const MEMBER_PRESENCE_TIMEOUT_MS = 60_000;

/** A room whose host has been away this long ends. */
export const HOST_ABANDON_TIMEOUT_MS = 30 * 60_000;

/** A host heartbeat re-anchors only when the host drifted further than this from the clock. */
export const HOST_REANCHOR_THRESHOLD_MS = 250;

/** The shared position at `now`; matches `targetPosition` in contracts. */
export const livePosition = (room: Doc<"rooms">, now: number): number =>
  room.status === "playing"
    ? room.positionAtAnchorMs + Math.max(0, now - room.anchorServerTime) * room.playbackRate
    : room.positionAtAnchorMs;
