/**
 * Which of AVPlayer's reported positions to believe. When its stream disappears AVPlayer raises no
 * error: it skips the segments that fail to the end of the playlist, or resets its clock to zero
 * while it reloads. Neither is where the viewer is, so neither may be saved as progress or used to
 * restart the stream. A position is believed when the playhead could have played there from the
 * last believed one, or when it plays on from a jump for a few seconds (a seek from the lock
 * screen moves AVPlayer without the app).
 *
 * Times are on a clock that runs only while AVPlayer plays: time spent paused, stalled, or loading
 * plays nothing, so a skip after it cannot pass for playing.
 */

/** A position the player reported, and when, on the playing clock in milliseconds. */
interface Sighting {
  readonly positionMs: number;
  readonly atMs: number;
}

/** Where a jump the player made on its own landed, and how far it has played on from there. */
interface Jump {
  readonly first: Sighting;
  readonly last: Sighting;
}

/** What the tracker believes about the playhead. */
export interface Playhead {
  /** The last position the player played to, or a seek the app asked for moved it to. */
  readonly believed: Sighting;
  /** A jump the player made on its own, believed once it has played on from there long enough. */
  readonly jump: Jump | null;
}

/**
 * How far behind the believed position a report may land: a seek or a new stream starts at the
 * keyframe or segment before its target.
 */
const BEHIND_MS = 10_000;

/** How far ahead of where playing would have taken it a report may land. */
const AHEAD_MS = 2_000;

/** How long a jump must play on before it is believed. */
const JUMP_BELIEVED_AFTER_MS = 3_000;

/** The slowest speed a jump must play on at, so a player stuck at zero is never believed. */
const SLOWEST_RATE = 0.25;

/** A playhead known to be at `positionMs` at `atMs`: a new stream's start, or a seek. */
export const placed = (positionMs: number, atMs: number): Playhead => ({
  believed: { positionMs, atMs },
  jump: null,
});

/** Whether playing at `rate` from `from` could have reached `positionMs` by `atMs`. */
const playsOnFrom = (from: Sighting, positionMs: number, atMs: number, rate: number): boolean => {
  const elapsed = Math.max(0, atMs - from.atMs);

  return (
    positionMs >= from.positionMs - BEHIND_MS &&
    positionMs <= from.positionMs + elapsed * Math.max(rate, 1) + AHEAD_MS
  );
};

/**
 * Whether the player could have played to `positionMs` by `atMs` from the believed position. Time
 * counts from the latest report: a player stuck somewhere else does not get closer by waiting.
 */
export const believes = (
  playhead: Playhead,
  positionMs: number,
  atMs: number,
  rate: number,
): boolean =>
  playsOnFrom(
    {
      positionMs: playhead.believed.positionMs,
      atMs: playhead.jump?.last.atMs ?? playhead.believed.atMs,
    },
    positionMs,
    atMs,
    rate,
  );

/**
 * Whether `positionMs` is where the player is known to be heading: a believed position, or a jump
 * it made on its own and may still play on from.
 */
export const explains = (
  playhead: Playhead,
  positionMs: number,
  atMs: number,
  rate: number,
): boolean =>
  believes(playhead, positionMs, atMs, rate) ||
  extendedJump(playhead, { positionMs, atMs }, rate) !== null;

/** The jump the player made on its own, played on to `sighting`; null when it made none or did not. */
const extendedJump = (playhead: Playhead, sighting: Sighting, rate: number): Jump | null =>
  playhead.jump !== null &&
  playsOnFrom(playhead.jump.last, sighting.positionMs, sighting.atMs, rate)
    ? { first: playhead.jump.first, last: sighting }
    : null;

/** Whether a jump moved at least the slowest speed over its playing, so it is not stuck. */
const playsOn = (jump: Jump): boolean =>
  jump.last.positionMs - jump.first.positionMs >= (jump.last.atMs - jump.first.atMs) * SLOWEST_RATE;

/** The playhead after the player reported `positionMs` at `atMs`, playing at `rate`. */
export const reported = (
  playhead: Playhead,
  positionMs: number,
  atMs: number,
  rate: number,
): Playhead => {
  const sighting = { positionMs, atMs };

  if (believes(playhead, positionMs, atMs, rate)) {
    return { believed: sighting, jump: null };
  }

  const jump = extendedJump(playhead, sighting, rate) ?? { first: sighting, last: sighting };

  const playedMs = jump.last.atMs - jump.first.atMs;

  return playedMs >= JUMP_BELIEVED_AFTER_MS && playsOn(jump)
    ? { believed: sighting, jump: null }
    : { believed: playhead.believed, jump };
};

/**
 * How long the player has played on from the jump it made on its own to `positionMs` at `atMs`; 0
 * when it made none, or did not play on from it. A skip through a vanished stream lands without
 * playing on.
 */
export const playedOnFromJumpMs = (
  playhead: Playhead,
  positionMs: number,
  atMs: number,
  rate: number,
): number => {
  const jump = extendedJump(playhead, { positionMs, atMs }, rate);

  return jump !== null && playsOn(jump) ? jump.last.atMs - jump.first.atMs : 0;
};

/**
 * The position to report for a live reading of `positionMs` at `atMs`: the reading when playing
 * could have reached it, else the believed position.
 */
export const believedPosition = (
  playhead: Playhead,
  positionMs: number,
  atMs: number,
  rate: number,
): number =>
  believes(playhead, positionMs, atMs, rate) ? positionMs : playhead.believed.positionMs;
