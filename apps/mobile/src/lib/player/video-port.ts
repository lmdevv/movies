import type { PlayerEvent, PlayerPort } from "@movies/sdk/effect";
import type { VideoPlayerEvents, VideoPlayerStatus } from "expo-video";

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
  #seeker: StreamSeeker = NATIVE_SEEKER;
  #pending: number | null = null;
  #move: AbortController | null = null;
  #loadingAt: number | null = null;
  #wantsPlay = false;
  #ended = false;
  #status: NativeStatus = "idle";
  #lastMs = 0;
  #final: number | null = null;
  #state: VideoState = { positionSeconds: 0, playing: false, buffering: false, ended: false };
  readonly #listeners = new Set<(event: PlayerEvent) => void>();
  readonly #stateListeners = new Set<() => void>();

  /**
   * Follows `video` from now on, a new stream's player whose source starts at `positionMs`: the
   * port reports that position, and no pause or stall, until it plays or seeks; seeks go through
   * `seeker`. A stream move that attaches the player of its new generation keeps going until it
   * lands.
   */
  attach(video: NativeVideo, positionMs: number, seeker: StreamSeeker): void {
    if (this.#final !== null) return;

    for (const subscription of this.#subscriptions) subscription.remove();
    this.#seeker = seeker;
    this.#loadingAt = positionMs;
    this.#lastMs = positionMs;
    this.#ended = false;
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
        this.#ended = true;
        this.#wantsPlay = false;
        this.#emit("ended");
        this.#changed();
      }),
      video.addListener("timeUpdate", ({ currentTime }) => {
        if (this.#pending === null && this.#loadingAt === null) this.#lastMs = currentTime * 1000;
        this.#changed();
      }),
    ];

    if (this.#wantsPlay) video.play();
    this.#changed();
  }

  /** Whether playing was asked for more recently than pausing. */
  readonly wantsToPlay = (): boolean => this.#wantsPlay;

  #settling(): boolean {
    return this.#pending !== null || this.#loadingAt !== null;
  }

  #onPlayingChange(isPlaying: boolean): void {
    if (isPlaying) {
      this.#loadingAt = null;
      this.#ended = false;
      this.#wantsPlay = true;
      this.#emit("playing");
    } else if (!this.#settling() && !this.#ended) {
      // Paused outside the app's controls too: Picture in Picture, the lock screen, AirPlay.
      this.#wantsPlay = false;
      this.#emit("paused");
    }

    this.#changed();
  }

  #onStatusChange(status: NativeStatus): void {
    this.#status = status;

    if (status === "loading" && this.#wantsPlay && !this.#settling()) this.#emit("waiting");
    this.#changed();
  }

  #emit(event: PlayerEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  readonly positionMs = (): number => {
    if (this.#final !== null) return this.#final;

    return this.#pending ?? this.#loadingAt ?? (this.#video?.currentTime ?? 0) * 1000;
  };

  readonly isPaused = (): boolean => {
    if (this.#final !== null) return true;

    return this.#settling() || this.#video === null ? !this.#wantsPlay : !this.#video.playing;
  };

  readonly isBuffering = (): boolean => {
    if (this.#final !== null || this.#ended) return false;

    if (this.#settling()) return this.#wantsPlay;

    return this.#wantsPlay && this.#status === "loading";
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

    if (this.#video !== null && this.#seeker.reaches(target)) {
      this.#pending = null;
      this.#loadingAt = null;
      this.#video.currentTime = target / 1000;
      this.#lastMs = target;
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
      this.#lastMs = target;
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
    const positionMs = this.#final ?? this.#pending ?? this.#loadingAt ?? this.#lastMs;

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
