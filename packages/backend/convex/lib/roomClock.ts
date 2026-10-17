/**
 * Room clock rules on the server. The constants equal those in `@movies/contracts/clock`; the
 * backend tests compare them.
 */
import type { Doc } from "../_generated/dataModel";

/** How often members send heartbeats; a host reading older than this cannot be right. */
export const HEARTBEAT_INTERVAL_MS = 5_000;

/**
 * An away heartbeat counts only once the device's player has been silent this long, two heartbeat
 * intervals. Until then the device is still watching: another tab on the same device may be
 * playing the room, or the heartbeat left the app just before its player opened.
 */
export const PLAYER_SILENCE_MS = 2 * HEARTBEAT_INTERVAL_MS;

/** A host silent this long is away and the room pauses. */
export const HOST_PRESENCE_TIMEOUT_MS = 20_000;

/** A guest silent this long leaves the member list. */
export const MEMBER_PRESENCE_TIMEOUT_MS = 60_000;

/** A room whose host has been away this long, or that no member's player played this long, ends. */
export const HOST_ABANDON_TIMEOUT_MS = 30 * 60_000;

/** A host heartbeat re-anchors only when the host drifted further than this from the clock. */
export const HOST_REANCHOR_THRESHOLD_MS = 50;

/** The threshold for a heartbeat without `atServerTime`, whose travel time counts as drift. */
export const UNTIMED_HOST_REANCHOR_THRESHOLD_MS = 250;

/** The fields of a room that determine its live position. */
export type ClockAnchor = Pick<
  Doc<"rooms">,
  "status" | "positionAtAnchorMs" | "anchorServerTime" | "playbackRate"
>;

/** The shared position at `now`; matches `targetPosition` in contracts. */
export const livePosition = (room: ClockAnchor, now: number): number =>
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

/**
 * Whether a live room is abandoned at `now`: its host silent for `HOST_ABANDON_TIMEOUT_MS`, or no
 * member's player reporting for that long (`watchedAt`; rows from before it was kept heard only
 * from players, so their `lastSeenAt`). Away heartbeats keep places, not rooms: a room everyone
 * left to browse ends as one the host left.
 */
export const isAbandoned = (
  room: Pick<Doc<"rooms">, "hostLastSeenAt">,
  members: ReadonlyArray<Pick<Doc<"roomMembers">, "watchedAt" | "lastSeenAt">>,
  now: number,
): boolean => {
  const lastPlayed = Math.max(...members.map((member) => member.watchedAt ?? member.lastSeenAt));

  return (
    now - room.hostLastSeenAt > HOST_ABANDON_TIMEOUT_MS ||
    (members.length > 0 && now - lastPlayed > HOST_ABANDON_TIMEOUT_MS)
  );
};

/** A paused clock at `positionAtAnchorMs`, anchored at the heartbeat that paused it. */
export interface PausedClock {
  readonly status: "paused";
  readonly positionAtAnchorMs: number;
  readonly anchorServerTime: number;
}

/**
 * What a heartbeat from a host browsing outside the player does to the room's clock, at `now`: null
 * keeps it. The clock is an anchor the server advances by itself, so a playing room plays on for
 * its guests without the host's player, whose heartbeats only correct that player's own drift. Two
 * states would otherwise last only as long as the host's player: a room frozen while the host
 * buffered pauses where it froze, and a playing room that ran past the end of its file
 * (`durationMs`) pauses at the end, as the host's player pauses there. A file whose length is
 * unknown (not positive) never ends this way.
 */
export const awayHostClock = (
  room: ClockAnchor,
  durationMs: number,
  now: number,
): PausedClock | null => {
  if (room.status === "buffering") {
    return { status: "paused", positionAtAnchorMs: room.positionAtAnchorMs, anchorServerTime: now };
  }

  if (room.status !== "playing" || !(durationMs > 0) || livePosition(room, now) < durationMs) {
    return null;
  }

  return { status: "paused", positionAtAnchorMs: durationMs, anchorServerTime: now };
};
