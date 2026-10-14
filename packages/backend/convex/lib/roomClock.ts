/**
 * Room clock rules on the server. The constants equal those in `@movies/contracts/clock`; the
 * backend tests compare them.
 */
import type { Doc } from "../_generated/dataModel";

/** How often members send heartbeats; a host reading older than this cannot be right. */
export const HEARTBEAT_INTERVAL_MS = 5_000;

/** A host silent this long is away and the room pauses. */
export const HOST_PRESENCE_TIMEOUT_MS = 20_000;

/** A guest silent this long leaves the member list. */
export const MEMBER_PRESENCE_TIMEOUT_MS = 60_000;

/** A room whose host has been away this long ends. */
export const HOST_ABANDON_TIMEOUT_MS = 30 * 60_000;

/** A host heartbeat re-anchors only when the host drifted further than this from the clock. */
export const HOST_REANCHOR_THRESHOLD_MS = 50;

/** The threshold for a heartbeat without `atServerTime`, whose travel time counts as drift. */
export const UNTIMED_HOST_REANCHOR_THRESHOLD_MS = 250;

/** The shared position at `now`; matches `targetPosition` in contracts. */
export const livePosition = (room: Doc<"rooms">, now: number): number =>
  room.status === "playing"
    ? room.positionAtAnchorMs + Math.max(0, now - room.anchorServerTime) * room.playbackRate
    : room.positionAtAnchorMs;

/** A host heartbeat's position as the server compares it with the room's live position. */
export interface HostReading {
  /** Where the host's player is at `now`. */
  readonly positionMs: number;
  /** How far from the live position it may be before the clock re-anchors on it. */
  readonly thresholdMs: number;
}

/**
 * Reads a host heartbeat's `positionMs` at `now`; matches `hostReading` in contracts. A reading
 * timed by `atServerTime` is carried forward to `now` in a playing room and gets the tight
 * threshold; one without a time, or with a time more than `HOST_REANCHOR_THRESHOLD_MS` ahead or
 * older than a heartbeat interval, counts as read at `now` and gets the untimed threshold.
 */
export const hostReading = (
  room: Doc<"rooms">,
  positionMs: number,
  atServerTime: number | undefined,
  now: number,
): HostReading => {
  const ageMs = atServerTime === undefined ? null : now - atServerTime;

  if (ageMs === null || ageMs < -HOST_REANCHOR_THRESHOLD_MS || ageMs > HEARTBEAT_INTERVAL_MS) {
    return { positionMs, thresholdMs: UNTIMED_HOST_REANCHOR_THRESHOLD_MS };
  }

  const carriedMs = room.status === "playing" ? Math.max(0, ageMs) * room.playbackRate : 0;

  return { positionMs: positionMs + carriedMs, thresholdMs: HOST_REANCHOR_THRESHOLD_MS };
};
