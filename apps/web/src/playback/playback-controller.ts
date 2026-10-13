/**
 * One movie or episode playing in one `<video>` element: the imperative shell of web playback.
 *
 * It starts a playback session, asks where to start when there is saved progress, negotiates a
 * stream with this browser's capabilities, attaches it, and reports progress through the SDK
 * until disposed (which ends the session). Failures follow `playback-policy`: a replaced HLS
 * generation reloads its playlist, a lost stream or an expired token renegotiates, a path the
 * browser cannot decode is dropped and the next one tried, and a missing file stops with its own
 * state. Tokens are renewed by renegotiating five minutes before they expire, so a six-hour token
 * never ends a long film. Audio tracks switch by renegotiating with the chosen track, and so do the
 * quality cap and picture subtitles (PGS, VobSub), which the media service burns into the video;
 * text subtitles are `<track>` elements and switch without a new stream.
 *
 * Every SDK call runs on the app's SDK runtime and comes back as a value; nothing here throws.
 */
import type { DeviceId, EpisodeId, ProfileId, RoomId, TitleId } from "@movies/contracts/ids";
import type { ClientCapabilities, NegotiateResponse } from "@movies/contracts/media-playback";
import type { StartedPlayback } from "@movies/contracts/models/playback";
import { Milliseconds } from "@movies/contracts/units";
import type { CallError } from "@movies/sdk/effect";
import { MoviesClient, Playback } from "@movies/sdk/effect";
import { Data, Effect, Exit, Option, Predicate, Result, Scope } from "effect";

import { withoutFailedPath } from "./capabilities";
import type { QualityChoice } from "./quality";
import { qualityCap } from "./quality";
import { ELEMENT_SEEKER, MediaElementPlayer, isBuffered } from "./media-element-player";
import type { StreamSeeker } from "./media-element-player";
import {
  PlaybackStep,
  PlaybackStop,
  STOPPED_MESSAGE,
  afterPlaybackFailure,
  afterSessionFailure,
  afterStreamFailure,
  offersResume,
} from "./playback-policy";
import type { AttachedStream, StreamFailure } from "./stream-attachment";
import { attachStream, preloadHlsJs } from "./stream-attachment";
import { RENEW_BEFORE_MS, inGeneration, runSdk } from "./sdk-calls";
import type { Runtime } from "./sdk-calls";
import { SwitchablePlayer } from "./switchable-player";

/** Where playback starts. */
export type StartChoice = Data.TaggedEnum<{
  /** Ask with the resume prompt when there is saved progress, else start at the beginning. */
  Ask: {};
  Resume: {};
  Beginning: {};
  /** At a position read when negotiating, such as a room's live position. */
  At: { readonly positionMs: () => number };
}>;

/** Constructors and matchers for `StartChoice`. */
export const StartChoice = Data.taggedEnum<StartChoice>();

/** What to play, for whom, and on which device. */
export interface PlaybackRequest {
  readonly profileId: ProfileId;
  readonly deviceId: DeviceId;
  readonly deviceName: string;
  readonly titleId: TitleId;
  readonly episodeId: EpisodeId | null;
  /** Play a watch room's file as one of its members. */
  readonly roomId: RoomId | null;
  readonly start: StartChoice;
  /** The quality this browser plays at, as the viewer last chose it. */
  readonly quality: QualityChoice;
}

/** Where playback stands. */
export type PlaybackPhase = Data.TaggedEnum<{
  /** Creating the playback session. */
  Starting: {};
  /** Waiting for the viewer to resume or start over. */
  Choosing: { readonly resumeAtMs: number };
  /** Negotiating and loading a stream; `progress` runs from 0 to 1. */
  Preparing: { readonly startAtMs: number; readonly progress: number };
  /** The stream showed its first frame; buffering and pausing are the element's business. */
  Playing: {};
  /** A path failed and another one is being negotiated. */
  Recovering: { readonly positionMs: number };
  Stopped: { readonly stop: PlaybackStop };
}>;

/** Constructors and matchers for `PlaybackPhase`. */
export const PlaybackPhase = Data.taggedEnum<PlaybackPhase>();

/** Everything the player UI reads. */
export interface PlaybackSnapshot {
  readonly phase: PlaybackPhase;
  readonly started: StartedPlayback | null;
  readonly stream: NegotiateResponse | null;
  /** The audio track playing, as an ffmpeg stream index. */
  readonly audioStreamIndex: number | null;
  /**
   * The subtitle track shown, or null for none. A picture subtitle shows once a stream that burns
   * it in has loaded; the stream's `burnedInSubtitle` says which one is in the video.
   */
  readonly subtitleId: string | null;
  readonly quality: QualityChoice;
  /**
   * The quality the loaded stream was negotiated with, once one has loaded; it trails `quality`
   * while a change negotiates, and never takes a choice the service refused.
   */
  readonly loadedQuality: QualityChoice | null;
  /** The browser refused to start playback until the viewer interacts with the page. */
  readonly needsGesture: boolean;
}

/** Recoveries in a row, without playback resuming between them, before playback gives up. */
const MAX_RECOVERIES = 3;

/** User Timing marks for first-frame measurements. */
const PLAYBACK_MARKS = {
  start: "movies:playback-start",
  firstFrame: "movies:first-frame",
} as const;

/** A defect or interruption in the SDK: nothing the viewer can fix but trying again. */
const STOPPED = PlaybackStop.Failed({ message: STOPPED_MESSAGE });

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const isPlaying = PlaybackPhase.$is("Playing");

/**
 * Answers to a negotiation the viewer asked for (another quality or picture subtitle) that mean
 * the service cannot give that stream now; the choice is undone and the current stream plays on.
 */
const UNHONOURED = [
  "UnsupportedPlayback",
  "TranscodeCapacityReached",
  "InsufficientTranscodeSpace",
] as const;

/** Plays one request in one element. Create it, `start` it, and `dispose` it. */
export class PlaybackController {
  /** The element as the SDK sees it. */
  readonly player: MediaElementPlayer;
  /**
   * The player the session plays on, for the progress reporter and the room engine: the element,
   * or a cast device the viewer switched to (`casting/`).
   */
  readonly output: SwitchablePlayer;
  readonly #runtime: Runtime;
  readonly #element: HTMLVideoElement;
  readonly #request: PlaybackRequest;
  readonly #hlsJs: boolean;
  #capabilities: ClientCapabilities;
  /** The picture subtitle the stream should burn in, or null. */
  #burnIn: string | null = null;
  /** Bumped by every change of quality or burned-in subtitle. */
  #choicesVersion = 0;
  /** Bumped by every negotiation and stop, so only the latest negotiation's answer is used. */
  #negotiation = 0;
  /**
   * The stream being attached: where it starts and whether it plays, which the element (still
   * reading 0, paused) does not tell yet; null otherwise.
   */
  #loading: { readonly atMs: number; readonly play: boolean } | null = null;
  #snapshot: PlaybackSnapshot = {
    phase: PlaybackPhase.Starting(),
    started: null,
    stream: null,
    audioStreamIndex: null,
    subtitleId: null,
    quality: "auto",
    loadedQuality: null,
    needsGesture: false,
  };
  readonly #listeners = new Set<() => void>();
  #playback: Playback.Playback | null = null;
  #attached: AttachedStream | null = null;
  /** Bumped by every new stream, so late callbacks of an older one do nothing. */
  #generation = 0;
  #recoveries = 0;
  #renewTimer: ReturnType<typeof setTimeout> | undefined;
  #reporting: Scope.Closeable | null = null;
  /** The playback the reporter was started with; it stops that stream when it closes. */
  #reported: Playback.Playback | null = null;
  #disposed = false;
  /** Another device plays the session (`park`); the element holds no stream meanwhile. */
  #parked = false;

  /**
   * @param hlsJs - Play HLS through hls.js rather than the element (`usesHlsJs`).
   */
  constructor(
    runtime: Runtime,
    element: HTMLVideoElement,
    capabilities: ClientCapabilities,
    hlsJs: boolean,
    request: PlaybackRequest,
  ) {
    this.#runtime = runtime;
    this.#element = element;
    this.#capabilities = capabilities;
    this.#hlsJs = hlsJs;
    this.#request = request;
    this.#snapshot = { ...this.#snapshot, quality: request.quality };
    this.player = new MediaElementPlayer(element);
    this.output = new SwitchablePlayer(this.player);
    element.addEventListener("playing", this.#onPlaying);
    element.addEventListener("loadeddata", this.#onFirstFrame);
  }

  /** The current state; a new object after every change. */
  readonly getSnapshot = (): PlaybackSnapshot => this.#snapshot;

  /** Calls `listener` after every change; returns the function that stops it. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);

    return () => {
      this.#listeners.delete(listener);
    };
  };

  #update(change: Partial<PlaybackSnapshot>): void {
    if (this.#disposed) return;
    this.#snapshot = { ...this.#snapshot, ...change };

    for (const listener of this.#listeners) listener();
  }

  #stop(stop: PlaybackStop): void {
    this.#negotiation += 1;
    this.#detach();
    this.#update({ phase: PlaybackPhase.Stopped({ stop }) });
  }

  /** Starts the session, then negotiates or asks where to start. */
  async start(): Promise<void> {
    performance.mark(PLAYBACK_MARKS.start);
    this.#update({ phase: PlaybackPhase.Starting() });

    const created = await this.#createSession();

    if (this.#disposed) return;

    if (created === null) return this.#stop(STOPPED);

    if (Result.isFailure(created)) return this.#follow(afterSessionFailure(created.failure), 0);

    const started = created.success;

    this.#update({ started });

    return StartChoice.$match(this.#request.start, {
      At: ({ positionMs }) => this.#negotiate(started, positionMs()),
      Beginning: () => this.#negotiate(started, 0),
      Resume: () => this.#negotiate(started, started.resumePositionMs),
      Ask: () => {
        if (!offersResume(started.resumePositionMs)) return this.#negotiate(started, 0);

        this.#update({ phase: PlaybackPhase.Choosing({ resumeAtMs: started.resumePositionMs }) });

        return Promise.resolve();
      },
    });
  }

  /** Creates the playback session, which ends this device's previous one. */
  #createSession(): Promise<Result.Result<StartedPlayback, CallError> | null> {
    const request = this.#request;

    return runSdk(
      this.#runtime,
      Effect.flatMap(MoviesClient.MoviesClient, (client) =>
        client.mutate("playback.createSession", {
          profileId: request.profileId,
          deviceId: request.deviceId,
          deviceName: request.deviceName,
          titleId: request.titleId,
          ...Option.match(Option.fromNullishOr(request.episodeId), {
            onNone: () => ({}),
            onSome: (episodeId) => ({ episodeId }),
          }),
          ...Option.match(Option.fromNullishOr(request.roomId), {
            onNone: () => ({}),
            onSome: (roomId) => ({ roomId }),
          }),
        }),
      ),
    );
  }

  /** Answers the resume prompt. */
  choose(from: "resume" | "beginning"): void {
    const { started, phase } = this.#snapshot;

    if (started === null || !PlaybackPhase.$is("Choosing")(phase)) return;

    void this.#negotiate(started, from === "resume" ? phase.resumeAtMs : 0);
  }

  async #negotiate(started: StartedPlayback, positionMs: number, play = true): Promise<void> {
    this.#update({ phase: PlaybackPhase.Preparing({ startAtMs: positionMs, progress: 0.35 }) });

    // Most streams this browser plays through hls.js need it; load it while negotiating. A failed
    // download surfaces when the stream attaches.
    if (this.#hlsJs) void preloadHlsJs().catch(() => undefined);

    const ticket = ++this.#negotiation;
    const version = this.#choicesVersion;
    const { quality } = this.#snapshot;

    const negotiated = await runSdk(
      this.#runtime,
      Playback.negotiate(
        started,
        this.#capabilities,
        Milliseconds.make(Math.max(0, positionMs)),
        Option.fromNullishOr(this.#snapshot.audioStreamIndex),
        this.#choices(),
      ),
    );

    if (this.#disposed || ticket !== this.#negotiation) return;

    if (negotiated === null) return this.#stop(STOPPED);

    if (Result.isFailure(negotiated)) {
      return this.#follow(afterPlaybackFailure(negotiated.failure), positionMs);
    }

    const playback: Playback.Playback = { started, stream: negotiated.success };

    this.#update({ phase: PlaybackPhase.Preparing({ startAtMs: positionMs, progress: 0.7 }) });
    this.#startReporting(playback);
    await this.#load(playback, play, quality);
    this.#catchUpOnChoices(version, ticket);
  }

  /**
   * Negotiates again when the viewer changed quality or subtitle while negotiation `ticket` ran
   * and no later negotiation (which asks with the new choices) has started since.
   */
  #catchUpOnChoices(version: number, ticket: number): void {
    const playback = this.#playback;

    if (
      this.#disposed ||
      playback === null ||
      ticket !== this.#negotiation ||
      version === this.#choicesVersion
    ) {
      return;
    }

    void this.#renegotiate(playback, this.#positionMs(), this.#snapshot.audioStreamIndex);
  }

  /** The playback position, or where the stream being attached starts. */
  #positionMs(): number {
    return this.#loading?.atMs ?? this.player.positionMs();
  }

  /** Whether playback is under way, or the stream being attached will play. */
  #playing(): boolean {
    return this.#loading?.play ?? !this.#element.paused;
  }

  /**
   * Puts `playback`'s stream, negotiated at `quality`, into the element, then plays it when `play`
   * is set.
   */
  async #load(playback: Playback.Playback, play: boolean, quality: QualityChoice): Promise<void> {
    this.#detach();

    const generation = ++this.#generation;
    const { stream } = playback;

    this.#loading = { atMs: stream.startSeconds * 1000, play };
    this.#playback = playback;
    this.#update({
      stream,
      started: playback.started,
      audioStreamIndex: stream.audio?.streamIndex ?? null,
    });
    this.#scheduleRenewal(stream);

    const attached = await attachStream(
      this.#element,
      stream,
      stream.startSeconds,
      this.#hlsJs,
      (failure) => {
        if (generation === this.#generation) this.#onStreamFailure(failure);
      },
    );

    if (this.#disposed || generation !== this.#generation) {
      attached.detach();

      return;
    }

    this.#attached = attached;
    this.#update({ loadedQuality: quality });
    this.player.setSeeker(stream.mode === "direct" ? ELEMENT_SEEKER : this.#hlsSeeker());

    if (play) await this.#play();

    if (generation === this.#generation) this.#loading = null;
  }

  async #play(): Promise<void> {
    try {
      await this.player.play();
      this.#update({ needsGesture: false });
    } catch {
      this.#update({ needsGesture: true });
    }
  }

  /** Plays after the browser asked for a gesture; call it from a click or key handler. */
  resumeWithGesture(): void {
    void this.#play();
  }

  #detach(): void {
    this.#loading = null;
    this.#attached?.detach();
    this.#attached = null;
    this.player.setSeeker(ELEMENT_SEEKER);
  }

  /** Seeks HLS outside what is buffered through the media service, which may start a generation. */
  #hlsSeeker(): StreamSeeker {
    return {
      reaches: (positionMs) => isBuffered(this.#element.buffered, positionMs / 1000),
      move: async (positionMs, signal) => {
        const playback = this.#playback;

        if (playback === null) return;

        const moved = await runSdk(
          this.#runtime,
          Playback.seekStream(playback, Milliseconds.make(positionMs)),
        );

        if (signal.aborted || this.#disposed || playback !== this.#playback) return;

        if (moved === null)
          return this.#follow(PlaybackStep.Renegotiate({ afterMs: 0 }), positionMs);

        if (Result.isFailure(moved)) {
          return this.#follow(afterPlaybackFailure(moved.failure), positionMs);
        }

        await this.#moveTo(playback, moved.success, positionMs);
      },
    };
  }

  /**
   * Continues `playback` in the generation a seek returned, or just seeks when it is the same. A
   * new generation empties the element, so it plays again once it can, unless the viewer (or the
   * room) paused meanwhile.
   */
  async #moveTo(
    playback: Playback.Playback,
    moved: Option.Option<{ readonly generation: number; readonly playlistUrl: string }>,
    positionMs: number,
  ): Promise<void> {
    const seconds = positionMs / 1000;

    if (Option.isNone(moved) || moved.value.generation === playback.stream.generation) {
      this.#element.currentTime = seconds;

      return;
    }

    const next = inGeneration(playback, moved.value);

    const attached = this.#attached;

    this.#playback = next;
    this.#update({ stream: next.stream });

    if (attached === null) return;
    await attached.reloadPlaylist(next.stream.url, seconds);

    if (this.#disposed || this.#playback !== next || !this.player.wantsToPlay()) return;
    await this.#play();
  }

  /**
   * Hands the session to another device, such as a Chromecast: the media service keeps one stream
   * per playback session, so the element lets go of its stream and nothing here negotiates (no
   * recovery, no token renewal, audio choices only noted) until `unpark`. The caller has switched
   * `output` to the other device first, so the element emptying itself is not reported.
   */
  park(): void {
    if (this.#parked || this.#disposed) return;
    this.#parked = true;
    clearTimeout(this.#renewTimer);
    // Late callbacks of the released stream belong to an old generation and do nothing.
    this.#generation += 1;
    this.#detach();
  }

  /** Whether another device plays the session now (`park`). */
  isParked(): boolean {
    return this.#parked;
  }

  /**
   * Takes the session back at `positionMs` after `park`: negotiates a new stream for this
   * browser there (renewing the token first when the other device kept it to the end) and plays
   * it when `play` is set.
   */
  unpark(positionMs: number, play: boolean): void {
    if (!this.#parked || this.#disposed) return;
    this.#parked = false;
    this.#recoveries = 0;

    const { started } = this.#snapshot;
    const playback = this.#playback;

    if (started === null) return;

    if (playback === null) {
      void this.#negotiate(started, positionMs, play);

      return;
    }

    this.#update({ phase: PlaybackPhase.Preparing({ startAtMs: positionMs, progress: 0.5 }) });
    void this.#renegotiate(playback, positionMs, this.#snapshot.audioStreamIndex, { play });
  }

  #onStreamFailure(failure: StreamFailure): void {
    void this.#follow(afterStreamFailure(failure), this.#positionMs());
  }

  /** Carries out a recovery step at `positionMs`. */
  async #follow(step: PlaybackStep, positionMs: number): Promise<void> {
    if (this.#disposed || this.#parked) return;

    if (PlaybackStep.$is("Stop")(step)) return this.#stop(step.stop);

    this.#recoveries += 1;

    if (this.#recoveries > MAX_RECOVERIES) return this.#stop(STOPPED);

    const playback = this.#playback;
    const { started } = this.#snapshot;

    if (started === null || PlaybackStep.$is("NewSession")(step)) return this.#restart(positionMs);

    if (playback === null) {
      if (PlaybackStep.$is("Renegotiate")(step)) await sleep(step.afterMs);

      return this.#negotiate(started, positionMs);
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
        this.#detach();
        this.#update({ phase: PlaybackPhase.Recovering({ positionMs }) });

        return this.#renegotiate(playback, positionMs, this.#snapshot.audioStreamIndex);
      },
      Renegotiate: async ({ afterMs }) => {
        await sleep(afterMs);

        return this.#renegotiate(playback, positionMs, this.#snapshot.audioStreamIndex);
      },
    });
  }

  /** Loads the stream's current generation at `positionMs`, renegotiating if that fails. */
  async #reloadPlaylist(playback: Playback.Playback, positionMs: number): Promise<void> {
    const moved = await runSdk(
      this.#runtime,
      Playback.seekStream(playback, Milliseconds.make(positionMs)),
    );

    if (this.#disposed || playback !== this.#playback) return;

    if (moved !== null && Result.isSuccess(moved)) {
      return this.#moveTo(playback, moved.success, positionMs);
    }

    return this.#renegotiate(playback, positionMs, this.#snapshot.audioStreamIndex);
  }

  /** Starts a new session at `positionMs`, as when the previous one ended elsewhere. */
  async #restart(positionMs: number): Promise<void> {
    this.#negotiation += 1;
    this.#detach();
    this.#playback = null;
    await this.#closeReporting();

    const created = this.#disposed ? null : await this.#createSession();

    if (this.#disposed) return;

    if (created === null) return this.#stop(STOPPED);

    if (Result.isFailure(created)) {
      return this.#follow(afterSessionFailure(created.failure), positionMs);
    }

    this.#update({ started: created.success });

    return this.#negotiate(created.success, positionMs);
  }

  /** Negotiates a new stream of the same session at `positionMs` and swaps it in. */
  async #renegotiate(
    playback: Playback.Playback,
    positionMs: number,
    audioStreamIndex: number | null,
    options: {
      /** Play the new stream, or not; by default as the old one was. */
      readonly play?: boolean;
      /**
       * For a negotiation the viewer asked for (another quality or picture subtitle): undoes the
       * choice when the service cannot honour it, and the current stream plays on.
       */
      readonly revert?: () => void;
    } = {},
  ): Promise<void> {
    if (this.#parked) return;
    const wasPlaying = this.#playing();
    const ticket = ++this.#negotiation;
    const version = this.#choicesVersion;
    const { quality } = this.#snapshot;

    const renewed = await runSdk(
      this.#runtime,
      Playback.renegotiate(
        playback,
        this.#capabilities,
        Milliseconds.make(Math.max(0, positionMs)),
        Option.fromNullishOr(audioStreamIndex),
        this.#choices(),
      ),
    );

    // A park while negotiating hands the session elsewhere; this stream is not wanted. Otherwise
    // the latest negotiation of this session wins, even when a stream loaded meanwhile.
    if (
      this.#disposed ||
      this.isParked() ||
      ticket !== this.#negotiation ||
      this.#playback?.started !== playback.started
    ) {
      return;
    }

    if (renewed === null) return this.#stop(STOPPED);

    if (Result.isFailure(renewed)) {
      if (
        options.revert !== undefined &&
        UNHONOURED.some((tag) => Predicate.isTagged(renewed.failure, tag))
      ) {
        options.revert();

        return;
      }

      return this.#follow(afterPlaybackFailure(renewed.failure), positionMs);
    }

    await this.#load(
      renewed.success,
      options.play ?? (wasPlaying || !isPlaying(this.#snapshot.phase)),
      quality,
    );
    this.#catchUpOnChoices(version, ticket);
  }

  #scheduleRenewal(stream: NegotiateResponse): void {
    clearTimeout(this.#renewTimer);

    const due = Math.max(0, stream.expiresAt - RENEW_BEFORE_MS - Date.now());

    this.#renewTimer = setTimeout(() => {
      const playback = this.#playback;

      if (playback === null || this.#disposed) return;

      void this.#renegotiate(playback, this.#positionMs(), this.#snapshot.audioStreamIndex);
    }, due);
  }

  /** Switches to another audio track by renegotiating with it. */
  selectAudio(streamIndex: number): void {
    const playback = this.#playback;

    if (playback === null || streamIndex === this.#snapshot.audioStreamIndex) return;

    this.#update({ audioStreamIndex: streamIndex });

    // While parked, the device playing the session follows the choice (`casting/`).
    if (!this.#parked) void this.#renegotiate(playback, this.#positionMs(), streamIndex);
  }

  /** The quality cap and burned-in subtitle every negotiation asks for. */
  #choices(): Playback.StreamChoices {
    return {
      quality: Option.fromNullishOr(qualityCap(this.#snapshot.quality)),
      burnInSubtitle: Option.fromNullishOr(this.#burnIn),
    };
  }

  /**
   * Shows the subtitle track `id`, or none. A picture subtitle needs a stream with it burned in,
   * and leaving one for a text track or none goes back to a stream without it: both renegotiate
   * at the current position. Text tracks switch in place.
   */
  selectSubtitle(id: string | null): void {
    const track = this.#snapshot.stream?.subtitles.find((candidate) => candidate.id === id);
    const burnIn = track?.kind === "bitmap" ? track.id : null;
    const previous = { subtitleId: this.#snapshot.subtitleId, burnIn: this.#burnIn };

    this.#update({ subtitleId: id });

    if (burnIn === this.#burnIn) return;

    this.#changeChoices(
      () => {
        this.#burnIn = burnIn;
      },
      () => {
        this.#burnIn = previous.burnIn;
        this.#update({ subtitleId: previous.subtitleId });
      },
    );
  }

  /** Plays at `quality` from here on, renegotiating when it changes. */
  selectQuality(quality: QualityChoice): void {
    const previous = this.#snapshot.quality;

    if (quality === previous) return;

    this.#changeChoices(
      () => this.#update({ quality }),
      () => this.#update({ quality: previous }),
    );
  }

  /**
   * Applies a change of quality or burned-in subtitle and negotiates a stream with it; `undo`
   * restores the old choice when the service cannot honour the new one. A change made while no
   * stream has loaded yet applies to the negotiation that loads one.
   */
  #changeChoices(apply: () => void, undo: () => void): void {
    apply();
    this.#choicesVersion += 1;

    const playback = this.#playback;

    if (playback === null) return;

    void this.#renegotiate(playback, this.#positionMs(), this.#snapshot.audioStreamIndex, {
      revert: () => {
        undo();
        this.#choicesVersion += 1;
      },
    });
  }

  /** Tries again from where playback stopped. */
  retry(): void {
    this.#recoveries = 0;

    const { started } = this.#snapshot;

    if (started === null) {
      void this.start();

      return;
    }

    void this.#negotiate(started, this.player.positionMs());
  }

  readonly #onFirstFrame = (): void => {
    if (isPlaying(this.#snapshot.phase)) return;

    performance.mark(PLAYBACK_MARKS.firstFrame, { detail: { mode: this.#snapshot.stream?.mode } });
    this.#update({ phase: PlaybackPhase.Playing() });
  };

  readonly #onPlaying = (): void => {
    this.#recoveries = 0;
    this.#onFirstFrame();
  };

  #startReporting(playback: Playback.Playback): void {
    if (this.#reporting !== null) return;

    const scope = Scope.makeUnsafe();

    this.#reporting = scope;
    this.#reported = playback;
    void this.#runtime.runPromiseExit(
      Scope.provide(scope)(Playback.reportProgress(playback, this.output)),
    );
  }

  async #closeReporting(): Promise<void> {
    const scope = this.#reporting;

    this.#reporting = null;

    if (scope !== null) await this.#runtime.runPromiseExit(Scope.close(scope, Exit.void));
  }

  /** Stops playback, ends the session (reporting where it stopped), and frees the element. */
  dispose(): void {
    if (this.#disposed) return;

    const { started } = this.#snapshot;
    const reporting = this.#reporting !== null;

    clearTimeout(this.#renewTimer);
    void this.#closeReporting();

    // The reporter stops the stream it started with; a renegotiated one replaced it.
    const current = this.#playback;

    if (current !== null && current.stream.streamId !== this.#reported?.stream.streamId) {
      void runSdk(this.#runtime, Playback.stop(current));
    }

    // A session that never reached a stream has no reporter to end it.
    if (!reporting && started !== null) {
      void this.#runtime.runPromiseExit(
        Effect.flatMap(MoviesClient.MoviesClient, (client) =>
          client.mutate("playback.endSession", {
            sessionId: started.sessionId,
            positionMs: Milliseconds.make(0),
          }),
        ),
      );
    }

    this.#disposed = true;
    this.#element.removeEventListener("playing", this.#onPlaying);
    this.#element.removeEventListener("loadeddata", this.#onFirstFrame);
    // Before detaching, which rewinds the element: the exit report reads the player afterwards.
    this.player.dispose();
    this.#detach();
    this.#listeners.clear();
  }
}
