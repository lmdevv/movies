/**
 * One playback session continued on a Chromecast: the imperative shell of casting.
 *
 * Casting keeps the page's playback session (and its token): the receiver gets its own stream,
 * negotiated with the Chromecast's client profile at the position the page reached, the page's
 * element pauses, and the controller's output player switches to the receiver, so progress keeps
 * reaching Convex and a watch room follows the TV. Subtitles and audio-track changes on the page
 * reach the receiver, and the cast renews its token before it expires (retrying while the media
 * service cannot answer). A seek outside what an HLS stream has produced moves the stream first
 * (`seekStream`), as the page's own player does, because the receiver would otherwise get
 * `StreamGenerationGone` for the old generation's segments; a seek within it happens on the
 * receiver at once. A receiver that refuses a stream, or a session that can no longer be played,
 * ends the cast through `onLost`. Ending the cast stops the receiver's stream and continues on the
 * page where the TV was.
 */
import { artworkUrl } from "@movies/contracts/artwork";
import { castCapabilities } from "@movies/contracts/cast";
import type { StartedPlayback } from "@movies/contracts/models/playback";
import { Milliseconds } from "@movies/contracts/units";
import { Playback } from "@movies/sdk/effect";
import { Option, Predicate, Result } from "effect";

import type { PlaybackController } from "@/playback/playback-controller";
import { RENEW_BEFORE_MS, inGeneration, runSdk } from "@/playback/sdk-calls";
import type { Runtime } from "@/playback/sdk-calls";
import { heldPlayer } from "@/playback/switchable-player";

import type { CastLoadRequest, CastSession } from "./cast-api";
import { CastPlayer } from "./cast-player";
import { castLoadPlan, castTrackIds } from "./cast-profile";
import type { CastItem, CastLoadPlan } from "./cast-profile";
import type { CastSdk } from "./cast-sdk";

/**
 * What a Chromecast is asked to play. The web sender SDK names a device but reports neither its
 * model nor its codecs (`chrome.cast.Receiver`), so every device gets the profile all of them
 * play; 4K, HEVC, and HDR wait for senders that know the model (the native apps).
 */
const CAST_CAPABILITIES = castCapabilities(undefined);

/** What a viewer reads when casting cannot start. */
export type CastFailure =
  /** The media service has no stream this device plays. */
  | "unsupported"
  /** The receiver refused or could not load the stream. */
  | "load-failed"
  /** The page had nothing playing to cast. */
  | "not-ready";

/** How long a failed renewal or reload waits before it tries again. */
const RETRY_MS = 30_000;

/**
 * How far past the receiver's position a seek stays on the receiver: the media service produces
 * well ahead of what a player asked for, so this part of a generation is there already.
 */
const IN_PLACE_AHEAD_MS = 30_000;

/**
 * Failures that may pass: the media service or Convex unreachable or busy. Anything else (a
 * session that ended, a token that cannot be renewed, a file gone) ends the cast.
 */
const PASSING_FAILURES = [
  "TransportError",
  "TranscodeCapacityReached",
  "InsufficientTranscodeSpace",
  "FileResolverUnavailable",
  "SegmentNotReady",
  "RateLimited",
  "Unavailable",
] as const;

const mayPass = (failure: { readonly _tag: string }): boolean =>
  PASSING_FAILURES.some((tag) => Predicate.isTagged(failure, tag));

/** Why a cast ended by itself, as the viewer reads it. */
const LOST = {
  refused: "The TV couldn't play this. Continuing here.",
  ended: "This can no longer play on the TV. Continuing here.",
  failed: "The TV stopped playing this. Continuing here.",
} as const;

/** The poster or still the TV shows for `started`'s item, as an absolute URL. */
export const castImage = (started: StartedPlayback, key: string | null): string | null =>
  key === null || key === "" ? null : artworkUrl(started.mediaBaseUrl, key, 500);

/** Builds the SDK's load request for `plan`, playing at once when `autoplay` is set. */
const loadRequest = (sdk: CastSdk, plan: CastLoadPlan, autoplay: boolean): CastLoadRequest => {
  const { media, Image } = sdk.cast;
  const info = new media.MediaInfo(plan.contentUrl, plan.contentType);
  const episode = plan.item.episode;

  const metadata =
    episode === null ? new media.MovieMediaMetadata() : new media.TvShowMediaMetadata();

  metadata.title = plan.item.title;
  metadata.images = plan.item.imageUrl === null ? [] : [new Image(plan.item.imageUrl)];

  if (episode !== null) {
    metadata.seriesTitle = episode.seriesTitle;
    metadata.season = episode.season;
    metadata.episode = episode.episode;
  }

  info.contentUrl = plan.contentUrl;
  info.streamType = "BUFFERED";
  info.duration = plan.durationSeconds;
  info.metadata = metadata;

  info.tracks = plan.tracks.map((track) => {
    const text = new media.Track(track.trackId, "TEXT");

    text.trackContentId = track.url;
    text.trackContentType = "text/vtt";
    text.subtype = "SUBTITLES";
    text.name = track.name;
    text.language = track.language;

    return text;
  });

  if (plan.hls) {
    info.hlsSegmentFormat = "fmp4";
    info.hlsVideoSegmentFormat = "fmp4";
  }

  const request = new media.LoadRequest(info);

  request.autoplay = autoplay;
  request.currentTime = plan.startSeconds;
  request.activeTrackIds = [...plan.activeTrackIds];

  return request;
};

/** A cast of one playback session. Create it with `start`, end it with `stop`. */
export class CastPlayback {
  readonly player: CastPlayer;
  readonly #runtime: Runtime;
  readonly #sdk: CastSdk;
  readonly #session: CastSession;
  readonly #controller: PlaybackController;
  readonly #item: CastItem;
  readonly #onLost: (message: string) => void;
  #playback: Playback.Playback;
  /** Where the receiver's current HLS generation starts; everything from there on is produced. */
  #generationStartMs: number;
  #plan: CastLoadPlan;
  #subtitleId: string | null;
  #audioStreamIndex: number | null;
  /**
   * The stream changes asked for (reloads, and seeks the media service moves), run one at a time:
   * the media service keeps only the newest stream of a session, so two at once could leave the
   * receiver on one already replaced.
   */
  #changes: Promise<void> = Promise.resolve();
  #changesPending = 0;
  /** Counts the reloads asked for; one that a later reload will redo skips itself. */
  #reloadTicket = 0;
  #renewTimer: ReturnType<typeof setTimeout> | undefined;
  #unsubscribe: () => void = () => undefined;
  #stopped = false;

  private constructor(
    runtime: Runtime,
    sdk: CastSdk,
    session: CastSession,
    controller: PlaybackController,
    item: CastItem,
    playing: { readonly playback: Playback.Playback; readonly plan: CastLoadPlan },
    onLost: (message: string) => void,
  ) {
    this.#runtime = runtime;
    this.#sdk = sdk;
    this.#session = session;
    this.#controller = controller;
    this.#item = item;
    this.#playback = playing.playback;
    this.#plan = playing.plan;
    this.#generationStartMs = playing.plan.startSeconds * 1000;
    this.#onLost = onLost;

    const snapshot = controller.getSnapshot();

    this.#subtitleId = snapshot.subtitleId;
    this.#audioStreamIndex = snapshot.audioStreamIndex;
    this.player = new CastPlayer(
      sdk.framework,
      (positionMs, signal) => this.#moveTo(positionMs, signal),
      () => session.getMediaSession()?.idleReason ?? null,
      () => {
        if (!this.#stopped) this.#onLost(LOST.failed);
      },
    );
  }

  /** The device's name, as the cast menu shows it. */
  get deviceName(): string {
    return this.#session.getCastDevice().friendlyName;
  }

  /**
   * Negotiates a stream for the device in `session` at the page's position, loads it there, and
   * hands the session to it. The media service keeps one stream per playback session, so the
   * receiver's stream replaces the page's, and the page waits (`park`) until the cast ends.
   * `onLost` hears when the cast can no longer go on, so the caller ends it.
   */
  static async start(
    runtime: Runtime,
    sdk: CastSdk,
    session: CastSession,
    controller: PlaybackController,
    item: CastItem,
    onLost: (message: string) => void,
  ): Promise<Result.Result<CastPlayback, CastFailure>> {
    const snapshot = controller.getSnapshot();
    const { started, stream } = snapshot;

    if (started === null || stream === null) return Result.fail("not-ready");

    const positionMs = controller.output.positionMs();
    const playing = !controller.output.isPaused();

    // The receiver's stream will replace the page's, so the page lets go first; until the
    // receiver plays, the session reports where the page was.
    controller.output.switchTo(heldPlayer(positionMs, !playing));
    controller.park();

    const resumeOnPage = (failure: CastFailure): Result.Result<CastPlayback, CastFailure> => {
      controller.output.switchTo(controller.player);
      controller.unpark(positionMs, playing);

      return Result.fail(failure);
    };

    const negotiated = await runSdk(
      runtime,
      Playback.renegotiate(
        { started, stream },
        CAST_CAPABILITIES,
        Milliseconds.make(Math.max(0, positionMs)),
        Option.fromNullishOr(snapshot.audioStreamIndex),
      ),
    );

    if (negotiated === null || Result.isFailure(negotiated)) return resumeOnPage("unsupported");

    const playback = negotiated.success;
    const plan = castLoadPlan(playback.stream, item, snapshot.subtitleId, positionMs / 1000);

    const failure = await session
      .loadMedia(loadRequest(sdk, plan, playing))
      .catch(() => "load-failed");

    if (failure !== undefined) {
      void runSdk(runtime, Playback.stop(playback));

      return resumeOnPage("load-failed");
    }

    const cast = new CastPlayback(
      runtime,
      sdk,
      session,
      controller,
      item,
      { playback, plan },
      onLost,
    );

    controller.output.switchTo(cast.player);
    cast.#begin();

    return Result.succeed(cast);
  }

  #begin(): void {
    this.#unsubscribe = this.#controller.subscribe(this.#onSnapshot);
    this.#scheduleRenewal();
  }

  /** Follows the page's subtitle and audio choices. */
  readonly #onSnapshot = (): void => {
    const { subtitleId, audioStreamIndex } = this.#controller.getSnapshot();

    if (this.#stopped) return;

    if (subtitleId !== this.#subtitleId) {
      this.#subtitleId = subtitleId;
      this.#showSubtitle(subtitleId);
    }

    if (audioStreamIndex !== this.#audioStreamIndex) {
      this.#audioStreamIndex = audioStreamIndex;
      void this.#reload();
    }
  };

  #showSubtitle(subtitleId: string | null): void {
    const media = this.#session.getMediaSession();
    const ids = castTrackIds(this.#plan.tracks, subtitleId);

    media?.editTracksInfo(
      new this.#sdk.cast.media.EditTracksInfoRequest([...ids]),
      () => undefined,
      () => undefined,
    );
  }

  /**
   * Renews the token (and so the receiver's stream) five minutes before it expires, unless the TV
   * finished meanwhile: reloading would wake it at the end of the film.
   */
  #scheduleRenewal(): void {
    clearTimeout(this.#renewTimer);

    const due = Math.max(0, this.#playback.stream.expiresAt - RENEW_BEFORE_MS - Date.now());

    this.#renewTimer = setTimeout(() => {
      if (!this.#stopped && !this.player.getState().ended) {
        void this.#reload();
      }
    }, due);
  }

  /** Runs `change` after every stream change asked for before it. */
  #serially(change: () => Promise<void>): Promise<void> {
    this.#changesPending += 1;

    const run = this.#changes.then(change).finally(() => {
      this.#changesPending -= 1;
    });

    this.#changes = run.catch(() => undefined);

    return run;
  }

  /**
   * Negotiates the receiver's stream again where it is (another audio track, a token about to
   * expire) and loads it, once the stream changes before it ran.
   */
  #reload(): Promise<void> {
    const ticket = ++this.#reloadTicket;

    return this.#serially(async () => {
      if (!this.#stopped && ticket === this.#reloadTicket) {
        await this.#renegotiate(this.player.positionMs());
      }
    });
  }

  /**
   * Negotiates the receiver's stream again at `positionMs` and loads it, keeping play or pause.
   * While the media service cannot answer it tries again every half minute; a session that can no
   * longer play ends the cast. Runs as a stream change.
   */
  async #renegotiate(positionMs: number): Promise<void> {
    const previous = this.#playback;

    const renewed = await runSdk(
      this.#runtime,
      Playback.renegotiate(
        previous,
        CAST_CAPABILITIES,
        Milliseconds.make(Math.max(0, positionMs)),
        Option.fromNullishOr(this.#audioStreamIndex),
      ),
    );

    if (this.#stopped) {
      // Stopped meanwhile: a stream just made is nobody's.
      if (renewed !== null && Result.isSuccess(renewed)) {
        void runSdk(this.#runtime, Playback.stop(renewed.success));
      }

      return;
    }

    if (renewed === null || Result.isFailure(renewed)) {
      if (renewed !== null && !mayPass(renewed.failure)) {
        this.#onLost(LOST.ended);

        return;
      }

      clearTimeout(this.#renewTimer);
      this.#renewTimer = setTimeout(() => {
        if (!this.#stopped) void this.#reload();
      }, RETRY_MS);

      return;
    }

    this.#playback = renewed.success;
    this.#scheduleRenewal();
    await this.#load(positionMs);
  }

  /**
   * Loads the current stream on the receiver at `positionMs`, keeping play or pause. A receiver
   * that refuses it ends the cast.
   */
  async #load(positionMs: number): Promise<void> {
    this.#plan = castLoadPlan(
      this.#playback.stream,
      this.#item,
      this.#subtitleId,
      positionMs / 1000,
    );
    this.#generationStartMs = positionMs;

    const failure = await this.#session
      .loadMedia(loadRequest(this.#sdk, this.#plan, !this.player.isPaused()))
      .catch(() => "load-failed");

    if (failure !== undefined && !this.#stopped) this.#onLost(LOST.refused);
  }

  /**
   * Whether the receiver can seek to `positionMs` itself: a direct file, or a produced position
   * (from the generation's start to a little past where the TV is).
   */
  #inPlace(positionMs: number): boolean {
    return (
      this.#playback.stream.streamId === undefined ||
      (positionMs >= this.#generationStartMs &&
        positionMs <= this.player.receiverPositionMs() + IN_PLACE_AHEAD_MS)
    );
  }

  /**
   * Moves the receiver to `positionMs`: on the receiver itself where it can, else through the media
   * service, which starts a new generation there for the receiver to load. A move waits for the
   * stream changes asked for before it, and one a newer seek replaced does not start.
   */
  #moveTo(positionMs: number, signal: AbortSignal): Promise<void> {
    if (this.#changesPending === 0 && this.#inPlace(positionMs)) {
      this.player.seekInPlace(positionMs);

      return Promise.resolve();
    }

    return this.#serially(async () => {
      // A newer seek replaced this one, or the cast ended (which aborts every move).
      if (signal.aborted) return;

      if (this.#inPlace(positionMs)) {
        this.player.seekInPlace(positionMs);

        return;
      }

      const playback = this.#playback;

      const moved = await runSdk(
        this.#runtime,
        Playback.seekStream(playback, Milliseconds.make(positionMs)),
      );

      // Once the media service moved the stream the receiver follows it, even for a seek replaced
      // meanwhile: the old generation is gone, and the newer seek runs next.
      if (this.#stopped) return;

      if (moved === null || Result.isFailure(moved)) {
        // The stream is gone (a restart, an idle timeout): negotiate a new one there.
        await this.#renegotiate(positionMs);

        return;
      }

      const next = Option.getOrUndefined(moved.success);

      if (next === undefined || next.generation === playback.stream.generation) {
        this.player.seekInPlace(positionMs);

        return;
      }

      this.#playback = inGeneration(playback, next);
      await this.#load(positionMs);
    });
  }

  /**
   * Ends the cast on the page's side and stops the receiver's stream. With `resume` (the device
   * disconnected), the page takes the session back where the TV was. Without it (the player is
   * closing), the session's output stays on the receiver's last position, so the exit report
   * saves where the TV stopped. The cast session itself is the caller's to end.
   */
  stop(resume: boolean): void {
    if (this.#stopped) return;
    this.#stopped = true;

    const positionMs = this.player.positionMs();
    const wasPlaying = !this.player.isPaused();

    clearTimeout(this.#renewTimer);
    this.#unsubscribe();
    this.player.dispose();
    void runSdk(this.#runtime, Playback.stop(this.#playback));

    if (!resume) return;
    this.#controller.output.switchTo(this.#controller.player);
    this.#controller.unpark(positionMs, wasPlaying);
  }
}
