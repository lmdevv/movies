import type { PlayerEvent, PlayerPort } from "@movies/sdk/effect";
import type { VideoPlayerEvents, VideoPlayerStatus } from "expo-video";

import { believedPosition, believes, explains, placed, reported, restarted } from "./playhead";
import type { Playhead } from "./playhead";

/** AVPlayer's loading state, as expo-video reports it. */
export type NativeStatus = VideoPlayerStatus;

/** The events of expo-video's player this port follows. */
export type NativeVideoEvents = Pick<
  VideoPlayerEvents,
  "playingChange" | "statusChange" | "playToEnd" | "timeUpdate"
>;

/** The parts of expo-video's `VideoPlayer` the port reads and drives. */
export interface NativeVideo {
  currentTime: number;
  playbackRate: number;
  readonly playing: boolean;
  readonly status: NativeStatus;
  /** Seconds buffered ahead from the start of the media; 0 or -1 when unknown. */
  readonly bufferedPosition: number;
  play(): void;
  pause(): void;
  addListener<Name extends keyof NativeVideoEvents>(
    event: Name,
    listener: NativeVideoEvents[Name],
  ): { remove(): void };
}

/** How a stream moves to positions AVPlayer cannot reach by itself. */
export interface StreamSeeker {
  /** Whether setting `currentTime` plays `positionMs`. */
  readonly reaches: (positionMs: number) => boolean;
  /**
   * Moves the stream so `positionMs` plays, such as loading a new HLS generation, and seeks there.
   * A newer seek aborts `signal`; the move must then leave the player alone.
   */
  readonly move: (positionMs: number, signal: AbortSignal) => Promise<void>;
}

/** Plays anywhere AVPlayer reaches, as a direct file does. */
export const NATIVE_SEEKER: StreamSeeker = {
  reaches: () => true,
  move: () => Promise.resolve(),
};

/** Where a new stream's player starts, how long its media runs, and how it seeks. */
export interface StreamStart {
  readonly positionMs: number;
  /** The media's duration as probed; null when unknown. */
  readonly durationMs: number | null;
  readonly seeker: StreamSeeker;
}

/**
 * How far into the media AVPlayer must have played for its end to be the media's end. AVPlayer
 * also reports an end when every remaining segment of a vanished stream fails.
 */
const ENDS_AFTER_FRACTION = 0.9;

/** How soon before an end AVPlayer's stop counts as that end rather than the viewer's pause. */
const STOPPED_FOR_END_MS = 1_000;

/** How far behind the playhead AVPlayer still holds an HLS stream's segments. */
const KEPT_BEHIND_SECONDS = 30;

/**
 * Whether an HLS seek to `targetSeconds` stays within what AVPlayer holds: from a little behind the
 * playhead, but not before `generationStartSeconds` where the playing generation began, to what it
 * buffered ahead, allowing the half second a keyframe search may need.
 */
export const withinBuffer = (
  currentSeconds: number,
  bufferedSeconds: number,
  generationStartSeconds: number,
  targetSeconds: number,
): boolean =>
  bufferedSeconds > currentSeconds &&
  targetSeconds >= Math.max(generationStartSeconds, currentSeconds - KEPT_BEHIND_SECONDS) &&
  targetSeconds <= bufferedSeconds + 0.5;

/** The player's state as the controls draw it. */
export interface VideoState {
  /** Where playback is, holding a seek's target until it lands. */
  readonly positionSeconds: number;
  /** Whether playing was asked for (by `play`) more recently than pausing. */
  readonly playing: boolean;
  readonly buffering: boolean;
  readonly ended: boolean;
}

/** A `PlayerPort` over the native player of the stream playing. */
export class VideoPort implements PlayerPort {
  #video: NativeVideo | null = null;
  #subscriptions: ReadonlyArray<{ remove(): void }> = [];
  readonly #now: () => number;
  #seeker: StreamSeeker = NATIVE_SEEKER;
  #durationMs: number | null = null;
  #pending: number | null = null;
  #move: AbortController | null = null;
  #loadingAt: number | null = null;
  #wantsPlay = false;
  #ended = false;
  #status: NativeStatus = "idle";
  /** AVPlayer stopped somewhere it could not have played to, as when its stream vanished. */
  #lost = false;
  #playhead: Playhead;
  /** When AVPlayer last paused outside the app's controls. */
  #pausedOutsideAt: number | null = null;
  #final: number | null = null;
  #state: VideoState = { positionSeconds: 0, playing: false, buffering: false, ended: false };
  readonly #listeners = new Set<(event: PlayerEvent) => void>();
  readonly #stateListeners = new Set<() => void>();

  /** @param now - A monotonic clock in milliseconds, which tells playing from skipping. */
  constructor(now: () => number = () => performance.now()) {
    this.#now = now;
    this.#playhead = placed(0, now());
  }

  /**
   * Follows `video` from now on, a new stream's player whose source starts at `start.positionMs`:
   * the port reports that position, and no pause or stall, until it plays or seeks; seeks go
   * through `start.seeker`. A stream move that attaches the player of its new generation keeps
   * going until it lands.
   */
  attach(video: NativeVideo, start: StreamStart): void {
    if (this.#final !== null) return;

    for (const subscription of this.#subscriptions) subscription.remove();
    this.#seeker = start.seeker;
    this.#durationMs = start.durationMs;
    this.#loadingAt = start.positionMs;
    this.#playhead = placed(start.positionMs, this.#now());
    this.#ended = false;
    this.#lost = false;
    this.#video = video;
    this.#status = video.status;
    this.#subscriptions = [
      video.addListener("playingChange", ({ isPlaying }) => {
        this.#onPlayingChange(isPlaying);
      }),
      video.addListener("statusChange", ({ status }) => {
        this.#onStatusChange(status);
      }),
      video.addListener("playToEnd", () => {
        this.#onPlayToEnd();
      }),
      video.addListener("timeUpdate", ({ currentTime }) => {
        if (!this.settling()) {
          this.#playhead = reported(
            this.#playhead,
            currentTime * 1000,
            this.#now(),
            this.playbackRate(),
          );
        }

        this.#changed();
      }),
    ];

    if (this.#wantsPlay) video.play();
    this.#changed();
  }

  /** Whether playing was asked for more recently than pausing. */
  readonly wantsToPlay = (): boolean => this.#wantsPlay;

  /**
   * Whether the player is heading for a position it has not reached: a new stream's start, or a
   * seek moving the stream.
   */
  readonly settling = (): boolean => this.#pending !== null || this.#loadingAt !== null;

  /** Whether AVPlayer's own position is one it could have played to. */
  #believable(): boolean {
    const video = this.#video;

    return (
      video !== null &&
      believes(this.#playhead, video.currentTime * 1000, this.#now(), this.playbackRate())
    );
  }

  /** AVPlayer stopped where it could not have played to: its stream is gone, not the viewer. */
  #loseStream(): void {
    this.#lost = true;

    if (this.#wantsPlay) this.#emit("waiting");
  }

  #onPlayingChange(isPlaying: boolean): void {
    const video = this.#video;

    // A jump AVPlayer made on its own, such as a seek from the lock screen, explains where it is.
    const explained =
      video !== null &&
      explains(this.#playhead, video.currentTime * 1000, this.#now(), this.playbackRate());

    // Paused or loading time plays nothing: a skip after it must not pass for playing.
    if (this.#pending === null) {
      this.#playhead = restarted(this.#playhead, this.positionMs(), this.#now());
    }

    if (isPlaying) {
      this.#loadingAt = null;
      this.#ended = false;
      this.#lost = false;
      this.#pausedOutsideAt = null;
      this.#wantsPlay = true;
      this.#emit("playing");
    } else if (this.settling() || this.#ended || this.#lost) {
      // Loading, seeking, ending, and a lost stream pause AVPlayer; the viewer did not.
    } else if (!explained) {
      this.#loseStream();
    } else if (this.#status !== "loading") {
      // Paused outside the app's controls too: Picture in Picture, the lock screen, AirPlay. A stall
      // stops AVPlayer as well, but expo-video reports it loading first.
      this.#wantsPlay = false;
      this.#pausedOutsideAt = this.#now();
      this.#emit("paused");
    }

    this.#changed();
  }

  #onPlayToEnd(): void {
    const reachedMs = this.positionMs();

    if (
      this.#believable() &&
      (this.#durationMs === null || reachedMs >= this.#durationMs * ENDS_AFTER_FRACTION)
    ) {
      this.#ended = true;
      this.#lost = false;
      this.#wantsPlay = false;
      this.#emit("ended");
    } else if (!this.#lost) {
      const stoppedForEnd =
        this.#pausedOutsideAt !== null && this.#now() - this.#pausedOutsideAt <= STOPPED_FOR_END_MS;

      if (stoppedForEnd) this.#wantsPlay = true;
      this.#loseStream();
    }

    this.#changed();
  }

  #onStatusChange(status: NativeStatus): void {
    this.#status = status;

    if (status === "loading" && this.#wantsPlay && !this.settling()) this.#emit("waiting");
    this.#changed();
  }

  #emit(event: PlayerEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  /**
   * Where playback is: a seek's target or a loading stream's start until it lands, else AVPlayer's
   * position when it could have played there, else the last position it played to.
   */
  readonly positionMs = (): number => {
    if (this.#final !== null) return this.#final;

    const settled = this.#pending ?? this.#loadingAt;

    if (settled !== null) return settled;

    if (this.#video === null) return this.#playhead.believed.positionMs;

    return believedPosition(
      this.#playhead,
      this.#video.currentTime * 1000,
      this.#now(),
      this.playbackRate(),
    );
  };

  #stalled(): boolean {
    return this.#lost || this.#status === "loading";
  }

  readonly isPaused = (): boolean => {
    if (this.#final !== null) return true;

    return this.settling() || this.#video === null || this.#stalled()
      ? !this.#wantsPlay
      : !this.#video.playing;
  };

  readonly isBuffering = (): boolean => {
    if (this.#final !== null || this.#ended) return false;

    if (this.settling()) return this.#wantsPlay;

    return this.#wantsPlay && this.#stalled();
  };

  readonly playbackRate = (): number => this.#video?.playbackRate ?? 1;

  readonly setPlaybackRate = (rate: number): void => {
    if (this.#final === null && this.#video !== null) this.#video.playbackRate = rate;
  };

  readonly seek = (positionMs: number): void => {
    if (this.#final !== null) return;

    const target = Math.max(0, positionMs);

    this.#move?.abort();
    this.#move = null;
    this.#ended = false;
    this.#lost = false;

    if (this.#video !== null && this.#seeker.reaches(target)) {
      this.#pending = null;
      this.#loadingAt = null;
      this.#video.currentTime = target / 1000;
      this.#playhead = placed(target, this.#now());
      this.#emit("seeked");
      this.#changed();

      return;
    }

    const move = new AbortController();

    this.#move = move;
    this.#pending = target;
    this.#emit("waiting");
    this.#changed();

    void this.#seeker.move(target, move.signal).finally(() => {
      if (move.signal.aborted) return;
      this.#move = null;
      this.#pending = null;
      this.#playhead = placed(target, this.#now());
      this.#emit("seeked");
      this.#changed();
    });
  };

  readonly play = (): Promise<void> => {
    if (this.#final !== null) return Promise.resolve();
    this.#wantsPlay = true;

    // At the end, playing starts over, as AVPlayer would not move on its own.
    if (this.#ended) this.seek(0);
    this.#video?.play();
    this.#changed();

    return Promise.resolve();
  };

  readonly pause = (): void => {
    if (this.#final !== null) return;
    this.#wantsPlay = false;
    this.#video?.pause();
    this.#changed();
  };

  readonly subscribe = (listener: (event: PlayerEvent) => void): (() => void) => {
    this.#listeners.add(listener);

    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** The state the controls draw; a new object after every change. */
  readonly getState = (): VideoState => this.#state;

  /** Calls `listener` after every change of `getState`; returns the function that stops it. */
  readonly subscribeState = (listener: () => void): (() => void) => {
    this.#stateListeners.add(listener);

    return () => {
      this.#stateListeners.delete(listener);
    };
  };

  #read(): VideoState {
    const positionMs =
      this.#final ?? this.#pending ?? this.#loadingAt ?? this.#playhead.believed.positionMs;

    return {
      positionSeconds: positionMs / 1000,
      playing: this.#wantsPlay,
      buffering: this.isBuffering(),
      ended: this.#ended,
    };
  }

  #changed(): void {
    const next = this.#read();
    const current = this.#state;

    if (
      Math.abs(next.positionSeconds - current.positionSeconds) < 0.05 &&
      next.playing === current.playing &&
      next.buffering === current.buffering &&
      next.ended === current.ended
    ) {
      return;
    }

    this.#state = next;

    for (const listener of this.#stateListeners) listener();
  }

  /**
   * Stops following the native player and keeps reporting where it stopped, paused. Call it before
   * releasing the native player.
   */
  dispose(): void {
    if (this.#final !== null) return;

    this.#final = this.positionMs();
    this.#move?.abort();

    for (const subscription of this.#subscriptions) subscription.remove();
    this.#subscriptions = [];
    this.#video = null;
    this.#listeners.clear();
    this.#stateListeners.clear();
  }
}
