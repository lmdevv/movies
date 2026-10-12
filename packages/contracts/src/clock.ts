/**
 * Shared-timeline math for watch rooms. Convex stores an anchored clock; every client computes the
 * live position locally from the server time it estimates, then corrects its player toward it.
 *
 * The thresholds and cadences here are starting points for the playback spike, not guarantees.
 */
import { Data } from "effect";

import type { RoomClock } from "./models/rooms";
import { EpochMillis, Milliseconds } from "./units";

/** How often the host and guests send room heartbeats. */
export const HEARTBEAT_INTERVAL_MS = 5_000;

/** A host silent this long is away: the server pauses the room at the live position. */
export const HOST_PRESENCE_TIMEOUT_MS = 20_000;

/** A guest silent this long is dropped from the member list. */
export const MEMBER_PRESENCE_TIMEOUT_MS = 60_000;

/** A room whose host has been away this long ends. */
export const HOST_ABANDON_TIMEOUT_MS = 30 * 60_000;

/**
 * A host heartbeat re-anchors the shared timeline only when the host's player is further than
 * this from the computed position, so small jitter does not churn revisions.
 */
export const HOST_REANCHOR_THRESHOLD_MS = 250;

/** Drift correction thresholds for a following player. */
export const DRIFT_THRESHOLDS = {
  /** Within this distance the player is in sync and left alone. */
  inSyncMs: 120,
  /** Beyond this distance the player seeks; between the two it adjusts its rate. */
  seekMs: 1_500,
  /** How far from the room's rate a nudging player runs, as a fraction. */
  nudgeRate: 0.05,
} as const;

/** The part of a room clock that determines the live position. */
export type ClockAnchor = Pick<
  RoomClock,
  "status" | "positionAtAnchorMs" | "anchorServerTime" | "playbackRate"
>;

/**
 * The shared position at `serverNow`. Playing clocks advance from their anchor at their rate;
 * paused, buffering, and ended clocks stay at the anchor.
 */
export const targetPosition = (clock: ClockAnchor, serverNow: EpochMillis): Milliseconds => {
  if (clock.status !== "playing") return clock.positionAtAnchorMs;
  const elapsed = Math.max(0, serverNow - clock.anchorServerTime);

  return Milliseconds.make(clock.positionAtAnchorMs + elapsed * clock.playbackRate);
};

/** What a following player should do to reach the shared position. */
export type DriftCorrection = Data.TaggedEnum<{
  InSync: {};
  /** Run at `rate` until back in sync. */
  Nudge: { readonly rate: number };
  /** Jump to `positionMs`. */
  Seek: { readonly positionMs: Milliseconds };
}>;

/** Constructors and matchers for `DriftCorrection`. */
export const DriftCorrection = Data.taggedEnum<DriftCorrection>();

/**
 * Classifies a player's drift from the shared position. Small drift is ignored, moderate drift is
 * corrected by running slightly faster or slower than `roomRate`, and large drift seeks.
 */
export const classifyDrift = (
  localPositionMs: Milliseconds,
  targetMs: Milliseconds,
  roomRate: number,
): DriftCorrection => {
  const drift = localPositionMs - targetMs;
  const distance = Math.abs(drift);

  if (distance <= DRIFT_THRESHOLDS.inSyncMs) return DriftCorrection.InSync();

  if (distance >= DRIFT_THRESHOLDS.seekMs) return DriftCorrection.Seek({ positionMs: targetMs });

  const direction = drift > 0 ? -1 : 1;

  return DriftCorrection.Nudge({ rate: roomRate * (1 + direction * DRIFT_THRESHOLDS.nudgeRate) });
};

/**
 * Whether `incoming` should replace the clock a client last applied. Clocks arrive over several
 * paths (subscription, command result, optimistic update); only a higher revision wins.
 */
export const isNewerRevision = (
  incoming: Pick<RoomClock, "revision">,
  applied: Pick<RoomClock, "revision"> | undefined,
): boolean => applied === undefined || incoming.revision > applied.revision;

/** One round trip to the server's clock, in the client's own milliseconds. */
export interface ClockSample {
  /** Client time when the request was sent. */
  readonly sentAt: number;
  /** Server time in the response. */
  readonly serverTime: EpochMillis;
  /** Client time when the response arrived. */
  readonly receivedAt: number;
}

/** An estimate of `serverTime - clientTime` and the round trip it came from. */
export interface ClockOffset {
  readonly offsetMs: number;
  readonly roundTripMs: number;
}

/**
 * Estimates the server clock offset from round-trip samples, trusting the sample with the shortest
 * round trip and assuming the server read its clock halfway through it. Returns `undefined` for no
 * samples.
 */
export const estimateClockOffset = (
  samples: ReadonlyArray<ClockSample>,
): ClockOffset | undefined => {
  const best = samples.reduce<ClockSample | undefined>(
    (shortest, sample) =>
      shortest === undefined ||
      sample.receivedAt - sample.sentAt < shortest.receivedAt - shortest.sentAt
        ? sample
        : shortest,
    undefined,
  );

  if (best === undefined) return undefined;
  const roundTripMs = Math.max(0, best.receivedAt - best.sentAt);

  return { offsetMs: best.serverTime - (best.sentAt + roundTripMs / 2), roundTripMs };
};

/** The server time corresponding to a client instant, given an estimated offset. */
export const toServerTime = (clientNow: number, offset: ClockOffset): EpochMillis =>
  EpochMillis.make(Math.max(0, Math.round(clientNow + offset.offsetMs)));
