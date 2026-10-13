/**
 * The SDK's `PlayerPort` over a Chromecast: positions and state come from the Cast SDK's mirror of
 * the receiver's player (`RemotePlayer`), and commands go through its `RemotePlayerController`. A
 * seek goes through `move`, which knows whether the receiver can seek by itself (a direct file) or
 * needs the stream moved first (HLS); until it lands, the player reports the target and counts as
 * buffering, as the element player does. Receivers play at normal speed only, so the room engine
 * corrects drift by seeking.
 */
import type { PlayerEvent, PlayerPort } from "@movies/sdk/effect";

import type {
  CastFramework,
  RemotePlayer,
  RemotePlayerChange,
  RemotePlayerController,
} from "./cast-api";

/** The receiver's player states, as the SDK names them. */
const BUFFERING = "BUFFERING";

const IDLE = "IDLE";

/** What the controls draw while casting. */
export interface RemoteState {
  readonly positionSeconds: number;
  readonly paused: boolean;
  readonly ended: boolean;
  readonly buffering: boolean;
  readonly volume: number;
  readonly muted: boolean;
}

/** A Chromecast's player as the progress reporter, the room engine, and the controls see it. */
export class CastPlayer implements PlayerPort {
  readonly #remote: RemotePlayer;
  readonly #controller: RemotePlayerController;
  readonly #changeEvent: string;
  readonly #move: (positionMs: number, signal: AbortSignal) => Promise<void>;
  readonly #finished: () => boolean;
  readonly #listeners = new Set<(event: PlayerEvent) => void>();
  readonly #watchers = new Set<() => void>();
  #pending: number | null = null;
  #moving: AbortController | null = null;
  #ended = false;
  /** Where the receiver was and whether it was paused while connected; a disconnect resets the mirror. */
  #last = { positionMs: 0, paused: true };
  #state: RemoteState;

  /**
   * @param move - Moves the receiver to a position, aborting when a newer seek replaces it.
   * @param finished - Whether the receiver's media stopped because it played to its end.
   */
  constructor(
    framework: CastFramework,
    move: (positionMs: number, signal: AbortSignal) => Promise<void>,
    finished: () => boolean,
  ) {
    this.#remote = new framework.RemotePlayer();
    this.#controller = new framework.RemotePlayerController(this.#remote);
    this.#changeEvent = framework.RemotePlayerEventType.ANY_CHANGE;
    this.#move = move;
    this.#finished = finished;
    this.#state = this.#read();
    this.#controller.addEventListener(this.#changeEvent, this.#onChange);
  }

  /** Stops following the receiver. */
  dispose(): void {
    this.#moving?.abort();
    this.#controller.removeEventListener(this.#changeEvent, this.#onChange);
    this.#listeners.clear();
    this.#watchers.clear();
  }

  /** The receiver's state now; a new object after every change. */
  readonly getState = (): RemoteState => this.#state;

  /** Calls `onChange` after every change of the receiver's state. */
  readonly watch = (onChange: () => void): (() => void) => {
    this.#watchers.add(onChange);

    return () => {
      this.#watchers.delete(onChange);
    };
  };

  #read(): RemoteState {
    return {
      positionSeconds: this.positionMs() / 1000,
      paused: this.isPaused(),
      ended: this.#ended,
      buffering: this.isBuffering(),
      volume: this.#remote.volumeLevel,
      muted: this.#remote.isMuted,
    };
  }

  #emit(event: PlayerEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  #refresh(): void {
    this.#state = this.#read();

    for (const watcher of this.#watchers) watcher();
  }

  readonly #onChange = (change: RemotePlayerChange): void => {
    // A disconnect resets the mirror (time to zero, paused), in whatever order the SDK reports
    // the fields; a jump to zero this player did not ask for is that reset, not a position.
    const reset =
      change.field === "currentTime" &&
      change.value === 0 &&
      this.#pending !== 0 &&
      this.#last.positionMs > 1_000;

    if (this.#remote.isConnected && !reset) {
      this.#last = { positionMs: this.#remote.currentTime * 1000, paused: this.#remote.isPaused };
    }

    if (change.field === "isPaused" && this.#pending === null) {
      if (change.value === false) this.#ended = false;
      this.#emit(change.value === true ? "paused" : "playing");
    }

    if (change.field === "playerState") {
      if (change.value === BUFFERING) this.#emit("waiting");

      // The receiver also goes idle on a stop, an error, or a new load; only `FINISHED` ends.
      if (change.value === IDLE && this.#pending === null && this.#finished()) {
        this.#ended = true;
        this.#emit("ended");
      }
    }

    this.#refresh();
  };

  readonly positionMs = (): number =>
    this.#pending ??
    (this.#remote.isConnected ? this.#remote.currentTime * 1000 : this.#last.positionMs);

  readonly isPaused = (): boolean =>
    this.#remote.isConnected ? this.#remote.isPaused : this.#last.paused;

  readonly isBuffering = (): boolean =>
    this.#pending !== null || (!this.#remote.isPaused && this.#remote.playerState === BUFFERING);

  readonly playbackRate = (): number => 1;

  readonly setPlaybackRate = (): void => undefined;

  readonly seek = (positionMs: number): void => {
    const target = Math.max(0, positionMs);
    const move = new AbortController();

    this.#moving?.abort();
    this.#moving = move;
    this.#pending = target;
    this.#emit("waiting");
    this.#refresh();

    void this.#move(target, move.signal).finally(() => {
      if (move.signal.aborted) return;
      this.#moving = null;
      this.#pending = null;
      this.#emit("seeked");
      this.#refresh();
    });
  };

  /** Seeks the receiver itself, as a direct file or the produced part of a stream allows. */
  seekInPlace(positionMs: number): void {
    this.#remote.currentTime = positionMs / 1000;
    this.#controller.seek();
  }

  readonly play = (): Promise<void> => {
    if (this.#remote.isPaused) this.#controller.playOrPause();

    return Promise.resolve();
  };

  readonly pause = (): void => {
    if (!this.#remote.isPaused) this.#controller.playOrPause();
  };

  /** Stops the receiver's media; the device stays connected. */
  stopReceiver(): void {
    this.#controller.stop();
  }

  /** Sets the receiver's volume, from 0 to 1, and unmutes it. */
  setVolume(volume: number): void {
    this.#remote.volumeLevel = Math.min(1, Math.max(0, volume));
    this.#controller.setVolumeLevel();

    if (this.#remote.isMuted) this.#controller.muteOrUnmute();
  }

  /** Mutes or unmutes the receiver. */
  setMuted(muted: boolean): void {
    if (this.#remote.isMuted !== muted) this.#controller.muteOrUnmute();
  }

  readonly subscribe = (listener: (event: PlayerEvent) => void): (() => void) => {
    this.#listeners.add(listener);

    return () => {
      this.#listeners.delete(listener);
    };
  };
}
