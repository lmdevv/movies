/**
 * Which of AVPlayer's reported positions to believe. When its stream disappears AVPlayer raises no
 * error: it skips the segments that fail to the end of the playlist, or resets its clock to zero
 * while it reloads. Neither is where the viewer is, so neither may be saved as progress or used to
 * restart the stream. A position is believed when the playhead could have played there from the
 * last believed one, or when it plays on from a jump for a few seconds (a seek from the lock
 * screen moves AVPlayer without the app).
 */

/** A position the player reported, and when, on a monotonic clock in milliseconds. */
interface Sighting {
  readonly positionMs: number;
  readonly atMs: number;
}

/** What the tracker believes about the playhead. */
export interface Playhead {
  /** The last position the player played to, or a seek the app asked for moved it to. */
  readonly believed: Sighting;
  /** A jump the player made on its own, believed once it has played on from there long enough. */
  readonly jump: { readonly first: Sighting; readonly last: Sighting } | null;
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

/**
 * A playhead known to be at `positionMs` at `atMs`: a new stream's start, a seek, or where the
 * player started or stopped playing. Time spent paused or stalled plays nothing, so a skip after
 * it cannot pass for playing.
 */
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
  (playhead.jump !== null && playsOnFrom(playhead.jump.last, positionMs, atMs, rate));

/**
 * The playhead once the player started or stopped playing at `atMs`, believed at `positionMs`.
 * Time it spent paused or stalled played nothing, so a skip after it cannot pass for playing; a
 * jump keeps the playing it showed so far.
 */
export const restarted = (playhead: Playhead, positionMs: number, atMs: number): Playhead => {
  const { jump } = playhead;

  if (jump === null) return placed(positionMs, atMs);

  const shift = atMs - jump.last.atMs;

  return {
    believed: { positionMs, atMs },
    jump: {
      first: { positionMs: jump.first.positionMs, atMs: jump.first.atMs + shift },
      last: { positionMs: jump.last.positionMs, atMs },
    },
  };
};

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

  const jump =
    playhead.jump !== null && playsOnFrom(playhead.jump.last, positionMs, atMs, rate)
      ? { first: playhead.jump.first, last: sighting }
      : { first: sighting, last: sighting };

  const playedMs = jump.last.atMs - jump.first.atMs;
  const advancedMs = jump.last.positionMs - jump.first.positionMs;

  return playedMs >= JUMP_BELIEVED_AFTER_MS && advancedMs >= playedMs * SLOWEST_RATE
    ? { believed: sighting, jump: null }
    : { believed: playhead.believed, jump };
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
