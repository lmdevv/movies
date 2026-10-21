/**
 * One movie or episode playing on this iPhone: the imperative shell of native playback, over the
 * session `usePlaybackSession` started (and reports progress for) through this controller's port.
 *
 * Each stream plays in its own AVPlayer, created with its source and start position so AVPlayer
 * asks for the right segment first. HLS seeks beyond what AVPlayer holds go through
 * `Playback.seekStream`, and a new generation loads in a new player at the target. Failures follow
 * `policy`: a replaced generation reloads its playlist, a lost stream or an expired token
 * renegotiates, a path AVPlayer cannot play is dropped and the next tried, and a missing file
 * stops with its own state. Tokens renew by renegotiating five minutes before they expire. Audio
 * tracks, the quality cap, and picture subtitles (burned in by the media service) renegotiate at
 * the current position; text subtitles are drawn by the screen and switch in place. A streamed
 * session also reports what AVPlayer saw (`diagnostics`): stalls, each stream attached, AVPlayer
 * failures, and every recovery.
 *
 * Every SDK call runs on the app's SDK runtime and comes back as a value; nothing here throws.
 */
import { PlayerObservation } from "@movies/contracts/diagnostics";
import type { ClientCapabilities, NegotiateResponse } from "@movies/contracts/media-playback";
import { Milliseconds } from "@movies/contracts/units";
import type { Movies } from "@movies/sdk/effect";
import { Playback, PlayerDiagnostics } from "@movies/sdk/effect";
import type { useMoviesRuntime } from "@movies/sdk/react";
import { Data, Effect, Exit, Option, Result, Scope, Struct } from "effect";
import { createVideoPlayer } from "expo-video";
import type { VideoMetadata, VideoPlayer } from "expo-video";

import { IOS_CAPABILITIES } from "@/lib/player/capabilities";
import {
  bufferedAheadSeconds,
  playerErrorObservation,
  recoveryObservation,
} from "@/lib/player/diagnostics";
import {
  MAX_RECOVERIES,
  PlaybackStep,
  PlaybackStop,
  STOPPED_MESSAGE,
  afterPlaybackFailure,
  afterPlayerError,
  withoutFailedPath,
  isUnhonoured,
} from "@/lib/player/policy";
import { lowerQuality, qualityCap } from "@/lib/player/quality";
import type { QualityChoice } from "@/lib/player/quality";
import { clampSubtitleDelay } from "@/lib/player/subtitle-delay";
import { NATIVE_SEEKER, VideoPort, withinBuffer } from "@/lib/player/video-port";
import type { StreamSeeker } from "@/lib/player/video-port";

/** The app's SDK runtime. */
type Runtime = ReturnType<typeof useMoviesRuntime>;

/** Where the player stands. */
export type PlayerPhase = Data.TaggedEnum<{
  /** Negotiating and loading a stream, until its first frame (F08). */
  Preparing: {};
  /** The stream showed its first frame; buffering and pausing are the port's business. */
  Playing: {};
  /** Playback cannot go on without the viewer (F09, F13). */
  Stopped: { readonly stop: PlaybackStop };
}>;

/** Constructors and matchers for `PlayerPhase`. */
export const PlayerPhase = Data.taggedEnum<PlayerPhase>();

/** Everything the player screen reads besides the port's own state. */
export interface PlayerSnapshot {
  readonly phase: PlayerPhase;
  readonly playback: Playback.Playback | null;
  /** The native player of the stream playing, for the video view. */
  readonly video: VideoPlayer | null;
  /** The audio track playing, as an ffmpeg stream index. */
  readonly audioStreamIndex: number | null;
  /** The subtitle track shown, or null for none. */
  readonly subtitleId: string | null;
  /** How much later than their file says text subtitles show, in milliseconds. */
  readonly subtitleDelayMs: number;
  readonly quality: QualityChoice;
  readonly rate: number;
}

/** A subtitle delay and the text track it was set for. */
interface SubtitleDelay {
  readonly trackId: string;
  readonly ms: number;
}

/** Renew the token and the stream this long before the token expires. */
const RENEW_BEFORE_MS = 5 * 60 * 1000;

/** How long a replaced player lives on, so the video view lets go of it first. */
const RETIRE_AFTER_MS = 1_000;

/** How often the native player reports the position. */
const TIME_UPDATE_SECONDS = 0.25;

const STOPPED = PlaybackStop.Interrupted({ message: STOPPED_MESSAGE });

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Runs `effect` and returns its success or failure; defects, interruption, and an SDK that could
 * not open become `null`.
 */
const runSdk = async <A, E>(
  runtime: Runtime,
  effect: Effect.Effect<A, E, Movies.Services>,
): Promise<Result.Result<A, E> | null> => {
  const exit = await runtime.runPromiseExit(Effect.result(effect));

  return Exit.isSuccess(exit) ? exit.value : null;
};

/** `playback` continued in the generation a seek started, at its playlist. */
const inGeneration = (
  playback: Playback.Playback,
  moved: { readonly generation: number; readonly playlistUrl: string },
): Playback.Playback => ({
  started: playback.started,
  stream: Struct.evolve(playback.stream, {
    url: () => moved.playlistUrl,
    generation: () => moved.generation,
  }),
});

/** What the controller needs from the screen. */
export interface PlayerControllerOptions {
  /** Start a new playback session at `positionMs`: the old one ended elsewhere. */
  readonly onNewSession: (positionMs: number) => void;
  /** The quality to start at, from App Settings' Streaming Quality. */
  readonly quality: QualityChoice;
}

/** Plays one session's streams. Create it, `start` it with the session, and `dispose` it. */
export class PlayerController {
  /** The player as the SDK's progress reporter sees it. */
  readonly port = new VideoPort();
  readonly #runtime: Runtime;
  readonly #options: PlayerControllerOptions;
  #capabilities: ClientCapabilities = IOS_CAPABILITIES;
  /** The stream the session started with; the reporter stops it when the session ends. */
  #original: Playback.Playback | null = null;
  #playback: Playback.Playback | null = null;
  #video: VideoPlayer | null = null;
  /** Records what AVPlayer sees for a streamed session, and the scope that sends it. */
  #diagnostics: {
    readonly recorder: PlayerDiagnostics.Recorder;
    readonly scope: Scope.Closeable;
  } | null = null;
  readonly #videoSubscriptions = new Map<VideoPlayer, { remove(): void }>();
  /** Bumped by every new stream, so late callbacks of an older one do nothing. */
  #generation = 0;
  /** Bumped by every negotiation and stop, so only the latest negotiation's answer is used. */
  #negotiation = 0;
  #recoveries = 0;
  #renewTimer: ReturnType<typeof setTimeout> | undefined;
  /** The picture subtitle the stream should burn in, or null. */
  #burnIn: string | null = null;
  #delay: SubtitleDelay | null = null;
  #volume = 1;
  /** Bumped by every seek the viewer makes, so a negotiation started before one is not loaded. */
  #seeks = 0;
  /** Where the HLS generation playing starts, in seconds; it holds nothing before that. */
  #generationStart = 0;
  /** Whether the stream playing was reloaded after AVPlayer failed it, since it last played. */
  #reloadedAfterError = false;
  /** Whether the video view showed a frame of this session yet. */
  #frameShown = false;
  /** What the lock screen and Control Center show for the next stream. */
  #metadata: VideoMetadata = {};
  #disposed = false;
  #snapshot: PlayerSnapshot = {
    phase: PlayerPhase.Preparing(),
    playback: null,
    video: null,
    audioStreamIndex: null,
    subtitleId: null,
    subtitleDelayMs: 0,
    quality: "auto",
    rate: 1,
  };
  readonly #listeners = new Set<() => void>();
  readonly #unsubscribePort: () => void;

  constructor(runtime: Runtime, options: PlayerControllerOptions) {
    this.#runtime = runtime;
    this.#options = options;
    this.#snapshot = { ...this.#snapshot, quality: options.quality };
    this.#unsubscribePort = this.port.subscribe((event) => {
      if (event === "playing") {
        this.#recoveries = 0;
        this.#reloadedAfterError = false;
      }
    });
  }

  /** Whether `dispose` ran, read afresh after an await. */
  #isDisposed(): boolean {
    return this.#disposed;
  }

  /** The current state; a new object after every change. */
  readonly getSnapshot = (): PlayerSnapshot => this.#snapshot;

  /** Calls `listener` after every change; returns the function that stops it. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);

    return () => {
      this.#listeners.delete(listener);
    };
  };

  #update(change: Partial<PlayerSnapshot>): void {
    if (this.#disposed) return;

    const next = { ...this.#snapshot, ...change };
    const delay = this.#delay;

    this.#snapshot = {
      ...next,
      subtitleDelayMs: delay !== null && delay.trackId === next.subtitleId ? delay.ms : 0,
    };

    for (const listener of this.#listeners) listener();
  }

  /**
   * Plays the session `usePlaybackSession` started, whose stream starts at the saved progress
   * unless the viewer asked to start over. It plays at once; there is no resume prompt. A
   * `streamed` session (not a kept download) reports what AVPlayer sees to the media service.
   */
  start(playback: Playback.Playback, streamed: boolean): void {
    if (this.#original !== null || this.#disposed) return;
    this.#original = playback;

    if (streamed) this.#diagnose();

    this.#update({ phase: PlayerPhase.Preparing() });
    this.#load(playback, playback.stream.startSeconds * 1000);
    void this.port.play();
  }

  #diagnose(): void {
    const scope = Scope.makeUnsafe();

    const started = this.#runtime.runSyncExit(
      Scope.provide(scope)(
        PlayerDiagnostics.reportDiagnostics(this.port, {
          platform: "ios",
          playback: () => Option.fromNullishOr(this.#playback),
          bufferedAheadSeconds: () =>
            this.#video === null ? 0 : bufferedAheadSeconds(this.#video),
          frames: () => Option.none(),
        }),
      ),
    );

    if (Exit.isSuccess(started)) this.#diagnostics = { recorder: started.value, scope };
  }

  #observe(observation: PlayerObservation): void {
    this.#diagnostics?.recorder.record(observation);
  }

  /** Stops recording and sends what was recorded since the last batch. */
  #closeDiagnostics(): void {
    const diagnostics = this.#diagnostics;

    this.#diagnostics = null;

    if (diagnostics !== null) {
      diagnostics.recorder.close();
      void this.#runtime.runPromiseExit(Scope.close(diagnostics.scope, Exit.void));
    }
  }

  /** Names what plays on the lock screen and in Control Center, from the next stream on. */
  setMetadata(metadata: VideoMetadata): void {
    this.#metadata = metadata;
  }

  /** Moves playback to `positionMs`, as the viewer asked. */
  seek(positionMs: number): void {
    this.#seeks += 1;
    this.port.seek(positionMs);
  }

  /** Loads `playback`'s stream in a new native player at `positionMs`, playing as the viewer wanted. */
  #load(playback: Playback.Playback, positionMs: number): void {
    const generation = ++this.#generation;
    const { stream } = playback;

    const video = createVideoPlayer({
      uri: stream.url,
      contentType: stream.mode === "direct" ? "auto" : "hls",
      metadata: this.#metadata,
    });

    // Set while the source loads, so AVPlayer applies it before asking for any media.
    video.currentTime = positionMs / 1000;
    video.timeUpdateEventInterval = TIME_UPDATE_SECONDS;
    video.volume = this.#volume;
    video.playbackRate = this.#snapshot.rate;
    video.staysActiveInBackground = true;
    video.showNowPlayingNotification = true;
    video.allowsExternalPlayback = true;
    this.#videoSubscriptions.set(
      video,
      video.addListener("statusChange", ({ status, error }) => {
        if (generation !== this.#generation) return;

        if (status === "error") this.#onPlayerError(error?.message);
      }),
    );

    this.#retire(this.#video);
    this.#video = video;
    this.#playback = playback;
    this.#generationStart = positionMs / 1000;
    this.port.attach(
      video,
      positionMs,
      stream.mode === "direct" ? NATIVE_SEEKER : this.#hlsSeeker(),
    );
    this.#update({ video, playback, audioStreamIndex: stream.audio?.streamIndex ?? null });
    this.#observe(PlayerObservation.cases.Attached.make({ mode: stream.mode, engine: "avplayer" }));
    this.#scheduleRenewal(stream);
  }

  /** Lets a replaced player go once the video view shows the next one. */
  #retire(video: VideoPlayer | null): void {
    if (video === null) return;

    this.#videoSubscriptions.get(video)?.remove();
    this.#videoSubscriptions.delete(video);
    video.pause();
    setTimeout(() => {
      video.release();
    }, RETIRE_AFTER_MS);
  }

  /**
   * The video view showed the stream's first frame: Preparing gives way to the video. AVPlayer's
   * ready state comes too early for that, before a transcode has produced a picture.
   */
  showedFrame(): void {
    this.#frameShown = true;

    if (PlayerPhase.$is("Preparing")(this.#snapshot.phase)) {
      this.#update({ phase: PlayerPhase.Playing() });
    }
  }

  #onPlayerError(message: string | undefined): void {
    const playback = this.#playback;

    if (playback === null) return;

    const observed = playerErrorObservation(message);
    const step = afterPlayerError(playback.stream, this.#reloadedAfterError);

    this.#observe(observed);

    if (PlaybackStep.$is("ReloadPlaylist")(step)) this.#reloadedAfterError = true;
    void this.#follow(step, this.port.positionMs(), message ?? "AVPlayer failed");
  }

  /** Seeks an HLS stream beyond what AVPlayer holds through the media service. */
  #hlsSeeker(): StreamSeeker {
    return {
      reaches: (positionMs) => {
        const video = this.#video;

        return (
          video !== null &&
          withinBuffer(
            video.currentTime,
            video.bufferedPosition,
            this.#generationStart,
            positionMs / 1000,
          )
        );
      },
      move: async (positionMs, signal) => {
        const playback = this.#playback;

        if (playback === null) return;

        const ticket = this.#negotiation;

        const moved = await runSdk(
          this.#runtime,
          Playback.seekStream(playback, Milliseconds.make(positionMs)),
        );

        // A newer seek, a negotiation, or a stop took over meanwhile.
        if (
          signal.aborted ||
          this.#isDisposed() ||
          playback !== this.#playback ||
          ticket !== this.#negotiation
        ) {
          return;
        }

        if (moved === null) {
          return this.#follow(
            PlaybackStep.Renegotiate({ afterMs: 0 }),
            positionMs,
            "The seek could not reach the media service",
          );
        }

        if (Result.isFailure(moved)) {
          return this.#follow(
            afterPlaybackFailure(moved.failure),
            positionMs,
            moved.failure.message,
          );
        }

        this.#moveTo(playback, moved.success, positionMs);
      },
    };
  }

  /**
   * Continues `playback` in the generation a seek returned, or just seeks when it is the same: the
   * service produces the segments from there in the current generation.
   */
  #moveTo(
    playback: Playback.Playback,
    moved: Option.Option<{ readonly generation: number; readonly playlistUrl: string }>,
    positionMs: number,
  ): void {
    if (Option.isNone(moved) || moved.value.generation === playback.stream.generation) {
      // The service keeps a generation only for a target within (or just past) what it produced,
      // so this range is contiguous; the floor still moves here, so a seek back from it asks the
      // service again rather than trusting segments AVPlayer never loaded.
      this.#generationStart = positionMs / 1000;

      if (this.#video !== null) this.#video.currentTime = positionMs / 1000;

      return;
    }

    this.#load(inGeneration(playback, moved.value), positionMs);
  }

  /** Carries out a recovery step at `positionMs`, after a failure `reason` describes. */
  async #follow(step: PlaybackStep, positionMs: number, reason: string): Promise<void> {
    if (this.#disposed) return;

    const recovery = recoveryObservation(step, reason);

    if (Option.isSome(recovery)) this.#observe(recovery.value);

    if (PlaybackStep.$is("Stop")(step)) return this.#stop(step.stop);

    this.#recoveries += 1;

    if (this.#recoveries > MAX_RECOVERIES) return this.#stop(STOPPED);

    const playback = this.#playback;

    if (playback === null || PlaybackStep.$is("NewSession")(step)) {
      this.#options.onNewSession(positionMs);

      return;
    }

    return PlaybackStep.$match(step, {
      Stop: () => Promise.resolve(),
      NewSession: () => Promise.resolve(),
      ReloadPlaylist: () => this.#reloadPlaylist(playback, positionMs),
      TryAnotherWay: () => {
        const narrower = withoutFailedPath(this.#capabilities, playback.stream);

        if (narrower === null) {
          this.#stop(PlaybackStop.Unsupported());

          return Promise.resolve();
        }

        this.#capabilities = narrower;

        return this.#renegotiate(positionMs);
      },
      Renegotiate: async ({ afterMs }) => {
        await sleep(afterMs);

        return this.#renegotiate(positionMs);
      },
    });
  }

  /** Loads the stream's current generation at `positionMs`, renegotiating if that fails. */
  async #reloadPlaylist(playback: Playback.Playback, positionMs: number): Promise<void> {
    const ticket = this.#negotiation;

    const moved = await runSdk(
      this.#runtime,
      Playback.seekStream(playback, Milliseconds.make(positionMs)),
    );

    // A negotiation or a stop took over meanwhile.
    if (this.#isDisposed() || playback !== this.#playback || ticket !== this.#negotiation) return;

    if (moved !== null && Result.isSuccess(moved)) {
      // A reload after an error needs a fresh player even in the same generation.
      const next = Option.getOrNull(moved.success);

      this.#load(next === null ? playback : inGeneration(playback, next), positionMs);

      return;
    }

    return this.#renegotiate(positionMs);
  }

  #stop(stop: PlaybackStop): void {
    this.#negotiation += 1;
    clearTimeout(this.#renewTimer);
    this.port.pause();
    this.#update({ phase: PlayerPhase.Stopped({ stop }) });
  }

  /** The quality cap and burned-in subtitle every negotiation asks for. */
  #choices(): Playback.StreamChoices {
    return {
      quality: Option.fromNullishOr(qualityCap(this.#snapshot.quality)),
      burnInSubtitle: Option.fromNullishOr(this.#burnIn),
    };
  }

  /**
   * Negotiates a new stream of the session at `positionMs` and swaps it in. `revert` undoes a
   * choice the viewer just made when the service cannot honour it; the current stream plays on.
   */
  async #renegotiate(positionMs: number, revert?: () => void): Promise<void> {
    const playback = this.#playback;

    if (playback === null || this.#disposed) return;

    const ticket = ++this.#negotiation;
    const seeks = this.#seeks;

    const renewed = await runSdk(
      this.#runtime,
      Playback.renegotiate(
        playback,
        this.#capabilities,
        Milliseconds.make(Math.max(0, positionMs)),
        Option.fromNullishOr(this.#snapshot.audioStreamIndex),
        this.#choices(),
      ),
    );

    // The latest negotiation of this session wins, even when a stream loaded meanwhile; a stream
    // nobody will play is stopped so its encoder does not run until the idle timeout.
    if (this.#isDisposed() || ticket !== this.#negotiation) {
      if (renewed !== null && Result.isSuccess(renewed)) this.#stopUnused(renewed.success);

      return;
    }

    // The viewer moved while it negotiated: a stream from the old position is not wanted.
    if (seeks !== this.#seeks) {
      if (renewed !== null && Result.isSuccess(renewed)) this.#stopUnused(renewed.success);

      return this.#renegotiate(this.port.positionMs(), revert);
    }

    if (renewed === null) return this.#stop(STOPPED);

    if (Result.isFailure(renewed) && isUnhonoured(renewed.failure)) {
      if (revert !== undefined) {
        revert();

        return;
      }

      if (this.#dropChoices()) return this.#renegotiate(positionMs);
    }

    if (Result.isFailure(renewed)) {
      return this.#follow(
        afterPlaybackFailure(renewed.failure),
        positionMs,
        renewed.failure.message,
      );
    }

    this.#load(renewed.success, positionMs);
  }

  /** Ends a negotiated stream that will not play. */
  #stopUnused(playback: Playback.Playback): void {
    void runSdk(this.#runtime, Playback.stop(playback));
  }

  /** Drops the quality cap and burned-in subtitle after a refusal; false when there were none. */
  #dropChoices(): boolean {
    if (this.#snapshot.quality === "auto" && this.#burnIn === null) return false;

    const shown = this.#burnIn === null ? this.#snapshot.subtitleId : null;

    this.#burnIn = null;
    this.#update({ quality: "auto", subtitleId: shown });

    return true;
  }

  #scheduleRenewal(stream: NegotiateResponse): void {
    clearTimeout(this.#renewTimer);

    const due = Math.max(0, stream.expiresAt - RENEW_BEFORE_MS - Date.now());

    this.#renewTimer = setTimeout(() => {
      void this.#renegotiate(this.port.positionMs());
    }, due);
  }

  /** Switches to another audio track by renegotiating with it. */
  selectAudio(streamIndex: number): void {
    const before = this.#snapshot.audioStreamIndex;

    if (streamIndex === before) return;

    this.#update({ audioStreamIndex: streamIndex });
    void this.#renegotiate(this.port.positionMs(), () => {
      this.#update({ audioStreamIndex: before });
    });
  }

  /**
   * Shows subtitle track `id`, or none. A picture subtitle needs a stream with it burned in, and
   * leaving one goes back to a stream without it: both renegotiate. Text tracks switch in place.
   */
  selectSubtitle(id: string | null): void {
    const track = this.#playback?.stream.subtitles.find((candidate) => candidate.id === id);
    const burnIn = track?.kind === "bitmap" ? track.id : null;
    const before = { subtitleId: this.#snapshot.subtitleId, burnIn: this.#burnIn };

    if (id !== null && burnIn === null && id !== this.#delay?.trackId) this.#delay = null;
    this.#update({ subtitleId: id });

    if (burnIn === this.#burnIn) return;

    this.#burnIn = burnIn;
    void this.#renegotiate(this.port.positionMs(), () => {
      this.#burnIn = before.burnIn;
      this.#update({ subtitleId: before.subtitleId });
    });
  }

  /** Shows the text subtitles `delayMs` later than their file says (earlier when negative). */
  setSubtitleDelay(delayMs: number): void {
    const { subtitleId } = this.#snapshot;

    if (subtitleId === null || this.#burnIn !== null) return;

    this.#delay = { trackId: subtitleId, ms: clampSubtitleDelay(delayMs) };
    this.#update({});
  }

  /** Plays at `quality` from here on, renegotiating when it changes. */
  selectQuality(quality: QualityChoice): void {
    const before = this.#snapshot.quality;

    if (quality === before) return;

    this.#update({ quality });
    void this.#renegotiate(this.port.positionMs(), () => {
      this.#update({ quality: before });
    });
  }

  /** Plays at `rate` times normal speed. */
  setRate(rate: number): void {
    this.port.setPlaybackRate(rate);
    this.#update({ rate });
  }

  /** Sets the app's own volume, from 0 to 1, for this and every later stream. */
  setVolume(volume: number): void {
    this.#volume = Math.min(1, Math.max(0, volume));

    if (this.#video !== null) this.#video.volume = this.#volume;
  }

  /** Tries again from where playback stopped (F09 Retry, F13 Try Again). */
  retry(): void {
    this.#recoveries = 0;
    // Once a frame showed, the new stream's loading shows as buffering over the video.
    this.#update({ phase: this.#frameShown ? PlayerPhase.Playing() : PlayerPhase.Preparing() });

    const positionMs = this.port.positionMs();

    if (this.#playback === null) {
      this.#options.onNewSession(positionMs);

      return;
    }

    void this.port.play();
    void this.#renegotiate(positionMs);
  }

  /** Tries again below the quality that played (F09 Try Lower Quality). */
  tryLowerQuality(): void {
    const height = this.#playback?.stream.video.height ?? 0;

    this.#update({ quality: lowerQuality(height) ?? "480p" });
    this.retry();
  }

  /**
   * Stops playback and lets the native players go. The session itself ends when
   * `usePlaybackSession` closes, which also stops the stream it started; a renegotiated stream
   * that replaced it is stopped here.
   */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    clearTimeout(this.#renewTimer);
    this.#unsubscribePort();

    this.#closeDiagnostics();

    // Before releasing the players: the exit report reads the port afterwards.
    this.port.dispose();

    const current = this.#playback;

    if (current !== null && current.stream.streamId !== this.#original?.stream.streamId) {
      void runSdk(this.#runtime, Playback.stop(current));
    }

    // Released a moment later, as a replaced player is, so the video view lets go of it first.
    this.#retire(this.#video);

    for (const subscription of this.#videoSubscriptions.values()) subscription.remove();
    this.#videoSubscriptions.clear();
    this.#video = null;
    this.#listeners.clear();
  }
}
