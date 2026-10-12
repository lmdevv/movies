/**
 * The SDK's `PlayerPort` over a `<video>` element, for the progress reporter and the room engine.
 * Positions are the element's `currentTime` on the source timeline (HLS generations keep source
 * timestamps). A seek the element cannot reach by itself, such as an HLS position whose segments
 * are not produced yet, goes through the stream's `StreamSeeker`; until it lands, the player
 * reports the target position and counts as buffering, so neither the engine nor the scrubber
 * jumps back.
 */
import type { PlayerEvent, PlayerPort } from "@movies/sdk/effect";

/** `TimeRanges` as the adapter reads it. */
export interface TimeRangesLike {
  readonly length: number;
  start(index: number): number;
  end(index: number): number;
}

/** The parts of `HTMLMediaElement` the adapter reads and drives; a `<video>` element is one. */
export interface MediaElementLike extends EventTarget {
  currentTime: number;
  playbackRate: number;
  readonly paused: boolean;
  readonly ended: boolean;
  readonly seeking: boolean;
  /** `HAVE_NOTHING` (0) to `HAVE_ENOUGH_DATA` (4). */
  readonly readyState: number;
  readonly buffered: TimeRangesLike;
  play(): Promise<void>;
  pause(): void;
}

/** How a stream moves to positions its element cannot reach alone. */
export interface StreamSeeker {
  /** Whether the element plays `positionMs` by setting `currentTime`. */
  readonly reaches: (positionMs: number) => boolean;
  /**
   * Moves the stream so `positionMs` plays, then seeks the element there. A newer seek aborts
   * `signal`; the move must then leave the element alone.
   */
  readonly move: (positionMs: number, signal: AbortSignal) => Promise<void>;
}

/** `HAVE_FUTURE_DATA`: enough data to play forward from the current position. */
const HAVE_FUTURE_DATA = 3;

/** Element events and the player events they become. `stalled` counts only while starved. */
const EVENTS: ReadonlyArray<readonly [string, PlayerEvent]> = [
  ["playing", "playing"],
  ["pause", "paused"],
  ["seeked", "seeked"],
  ["waiting", "waiting"],
  ["stalled", "waiting"],
  ["ended", "ended"],
];

/** Plays anywhere the element itself reaches, as direct files do. */
export const ELEMENT_SEEKER: StreamSeeker = {
  reaches: () => true,
  move: () => Promise.resolve(),
};

/** Whether `ranges` hold `seconds`, allowing the half second a keyframe search may need. */
export const isBuffered = (ranges: TimeRangesLike, seconds: number): boolean =>
  Array.from({ length: ranges.length }, (_, index) => index).some(
    (index) => ranges.start(index) - 0.5 <= seconds && seconds <= ranges.end(index),
  );

const isAbort = (cause: unknown): boolean =>
  cause instanceof DOMException && cause.name === "AbortError";

/**
 * A `PlayerPort` over one media element. `play` rejects only when the browser refuses to start
 * playback (autoplay without a gesture); a play interrupted by a pause or a new source resolves.
 */
export class MediaElementPlayer implements PlayerPort {
  readonly #element: MediaElementLike;
  #seeker: StreamSeeker = ELEMENT_SEEKER;
  /** The target of a stream seek in progress. */
  #pending: number | null = null;
  #move: AbortController | null = null;
  readonly #listeners = new Set<(event: PlayerEvent) => void>();

  /** Wraps `element`; call `dispose` when the element goes away. */
  constructor(element: MediaElementLike) {
    this.#element = element;

    for (const [type] of EVENTS) element.addEventListener(type, this.#onElementEvent);
  }

  /** Uses `seeker` for seeks from now on, such as the HLS stream just loaded. */
  setSeeker(seeker: StreamSeeker): void {
    this.#seeker = seeker;
  }

  /** Stops listening to the element. */
  dispose(): void {
    this.#move?.abort();

    for (const [type] of EVENTS) this.#element.removeEventListener(type, this.#onElementEvent);
    this.#listeners.clear();
  }

  readonly #onElementEvent = (event: Event): void => {
    const mapped = EVENTS.find(([type]) => type === event.type)?.[1];

    if (mapped === undefined) return;

    if (event.type === "stalled" && this.#element.readyState >= HAVE_FUTURE_DATA) return;

    // Seeks inside a stream move fire their own `seeked`; the move reports one when it lands.
    if (mapped === "seeked" && this.#pending !== null) return;

    this.#emit(mapped);
  };

  #emit(event: PlayerEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  readonly positionMs = (): number => this.#pending ?? this.#element.currentTime * 1000;

  readonly isPaused = (): boolean => this.#element.paused;

  readonly isBuffering = (): boolean => {
    const element = this.#element;

    if (element.paused || element.ended) return false;

    return this.#pending !== null || element.seeking || element.readyState < HAVE_FUTURE_DATA;
  };

  readonly playbackRate = (): number => this.#element.playbackRate;

  readonly setPlaybackRate = (rate: number): void => {
    this.#element.playbackRate = rate;
  };

  readonly seek = (positionMs: number): void => {
    const target = Math.max(0, positionMs);

    this.#move?.abort();
    this.#move = null;

    if (this.#seeker.reaches(target)) {
      this.#pending = null;
      this.#element.currentTime = target / 1000;

      return;
    }

    const move = new AbortController();

    this.#move = move;
    this.#pending = target;
    this.#emit("waiting");

    void this.#seeker.move(target, move.signal).finally(() => {
      // A newer seek owns the pending target now.
      if (move.signal.aborted) return;
      this.#move = null;
      this.#pending = null;
      this.#emit("seeked");
    });
  };

  readonly play = async (): Promise<void> => {
    try {
      await this.#element.play();
    } catch (cause) {
      if (!isAbort(cause)) throw cause;
    }
  };

  readonly pause = (): void => {
    this.#element.pause();
  };

  readonly subscribe = (listener: (event: PlayerEvent) => void): (() => void) => {
    this.#listeners.add(listener);

    return () => {
      this.#listeners.delete(listener);
    };
  };
}
