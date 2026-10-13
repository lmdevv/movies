/**
 * One playback session continued on a Chromecast: the imperative shell of casting.
 *
 * Casting keeps the page's playback session (and its token): the receiver gets its own stream,
 * negotiated with the Chromecast's client profile at the position the page reached, the page's
 * element pauses, and the controller's output player switches to the receiver, so progress keeps
 * reaching Convex and a watch room follows the TV. Subtitles, audio-track changes, and token
 * renewals on the page reload the receiver at its position. A seek outside what an HLS stream has
 * produced moves the stream first (`seekStream`), as the page's own player does, because the
 * receiver would otherwise get `StreamGenerationGone` for the old generation's segments. Ending
 * the cast stops the receiver's stream and continues on the page where the TV was.
 */
import { artworkUrl } from "@movies/contracts/artwork";
import { castCapabilities } from "@movies/contracts/cast";
import type { StartedPlayback } from "@movies/contracts/models/playback";
import { Milliseconds } from "@movies/contracts/units";
import { Playback } from "@movies/sdk/effect";
import type { MoviesClient } from "@movies/sdk/effect";
import type { useMoviesRuntime } from "@movies/sdk/react";
import { Effect, Exit, Option, Result, Struct } from "effect";

import type { PlaybackController } from "@/playback/playback-controller";
import { heldPlayer } from "@/playback/switchable-player";

import type { CastLoadRequest, CastSession } from "./cast-api";
import { CastPlayer } from "./cast-player";
import { castLoadPlan, castTrackIds } from "./cast-profile";
import type { CastItem, CastLoadPlan } from "./cast-profile";
import type { CastSdk } from "./cast-sdk";

type Runtime = ReturnType<typeof useMoviesRuntime>;

/**
 * What a Chromecast is asked to play. The web sender SDK names a device but reports neither its
 * model nor its codecs (`chrome.cast.Receiver`), so every device gets the profile all of them
 * play; 4K, HEVC, and HDR wait for senders that know the model (the native apps).
 */
const CAST_CAPABILITIES = castCapabilities(undefined);

/** The receiver's idle reason after media played to its end. */
const FINISHED = "FINISHED";

/** What a viewer reads when casting cannot start. */
export type CastFailure =
  /** The media service has no stream this device plays. */
  | "unsupported"
  /** The receiver refused or could not load the stream. */
  | "load-failed"
  /** The page had nothing playing to cast. */
  | "not-ready";

/** Runs `effect`; defects and interruption become `null`. */
const run = async <A, E>(
  runtime: Runtime,
  effect: Effect.Effect<A, E, MoviesClient.MoviesClient>,
): Promise<Result.Result<A, E> | null> => {
  const exit = await runtime.runPromiseExit(Effect.result(effect));

  return Exit.isSuccess(exit) ? exit.value : null;
};

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

/** Renew the token and the receiver's stream this long before the token expires. */
const RENEW_BEFORE_MS = 5 * 60 * 1000;

/** A cast of one playback session. Create it with `start`, end it with `stop`. */
export class CastPlayback {
  readonly player: CastPlayer;
  readonly #runtime: Runtime;
  readonly #sdk: CastSdk;
  readonly #session: CastSession;
  readonly #controller: PlaybackController;
  readonly #item: CastItem;
  #playback: Playback.Playback;
  #plan: CastLoadPlan;
  #subtitleId: string | null;
  #audioStreamIndex: number | null;
  /** Bumped by every stream change, so a seek or reload that returns late does nothing. */
  #version = 0;
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
  ) {
    this.#runtime = runtime;
    this.#sdk = sdk;
    this.#session = session;
    this.#controller = controller;
    this.#item = item;
    this.#playback = playing.playback;
    this.#plan = playing.plan;

    const snapshot = controller.getSnapshot();

    this.#subtitleId = snapshot.subtitleId;
    this.#audioStreamIndex = snapshot.audioStreamIndex;
    this.player = new CastPlayer(
      sdk.framework,
      (positionMs, signal) => this.#moveTo(positionMs, signal),
      () => session.getMediaSession()?.idleReason === FINISHED,
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
   */
  static async start(
    runtime: Runtime,
    sdk: CastSdk,
    session: CastSession,
    controller: PlaybackController,
    item: CastItem,
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

    const negotiated = await run(
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
      void run(runtime, Playback.stop(playback));

      return resumeOnPage("load-failed");
    }

    const cast = new CastPlayback(runtime, sdk, session, controller, item, { playback, plan });

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
      void this.#reload(this.player.positionMs());
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

  /** Renews the token (and so the receiver's stream) five minutes before it expires. */
  #scheduleRenewal(): void {
    clearTimeout(this.#renewTimer);

    const due = Math.max(0, this.#playback.stream.expiresAt - RENEW_BEFORE_MS - Date.now());

    this.#renewTimer = setTimeout(() => {
      if (!this.#stopped) void this.#reload(this.player.positionMs());
    }, due);
  }

  /**
   * Negotiates the receiver's stream again at `positionMs` (another audio track, a token about to
   * expire, a stream the media service lost) and loads it, keeping play or pause.
   */
  async #reload(positionMs: number): Promise<void> {
    const version = ++this.#version;
    const previous = this.#playback;

    const renewed = await run(
      this.#runtime,
      Playback.renegotiate(
        previous,
        CAST_CAPABILITIES,
        Milliseconds.make(Math.max(0, positionMs)),
        Option.fromNullishOr(this.#audioStreamIndex),
      ),
    );

    if (renewed === null || Result.isFailure(renewed)) return;

    // Stopped or overtaken meanwhile: the stream just made is nobody's.
    if (this.#stopped || version !== this.#version) {
      void run(this.#runtime, Playback.stop(renewed.success));

      return;
    }

    this.#playback = renewed.success;
    this.#scheduleRenewal();
    await this.#load(positionMs);
  }

  /** Loads the current stream on the receiver at `positionMs`, keeping play or pause. */
  async #load(positionMs: number): Promise<void> {
    this.#plan = castLoadPlan(
      this.#playback.stream,
      this.#item,
      this.#subtitleId,
      positionMs / 1000,
    );

    await this.#session
      .loadMedia(loadRequest(this.#sdk, this.#plan, !this.player.isPaused()))
      .catch(() => undefined);
  }

  /** Moves the receiver to `positionMs`: in place for a direct file or a produced position. */
  async #moveTo(positionMs: number, signal: AbortSignal): Promise<void> {
    const playback = this.#playback;
    const version = this.#version;

    if (playback.stream.streamId === undefined) {
      this.player.seekInPlace(positionMs);

      return;
    }

    const moved = await run(
      this.#runtime,
      Playback.seekStream(playback, Milliseconds.make(positionMs)),
    );

    // A newer seek, a reload, or the end of the cast took over meanwhile.
    if (signal.aborted || this.#stopped || version !== this.#version) return;

    if (moved === null || Result.isFailure(moved)) {
      // The stream is gone (a restart, an idle timeout): negotiate a new one there.
      await this.#reload(positionMs);

      return;
    }

    const next = Option.getOrUndefined(moved.success);

    if (next === undefined || next.generation === playback.stream.generation) {
      this.player.seekInPlace(positionMs);

      return;
    }

    this.#version += 1;
    this.#playback = {
      started: playback.started,
      stream: Struct.evolve(playback.stream, {
        url: () => next.playlistUrl,
        generation: () => next.generation,
      }),
    };
    await this.#load(positionMs);
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
    void run(this.#runtime, Playback.stop(this.#playback));

    if (!resume) return;
    this.#controller.output.switchTo(this.#controller.player);
    this.#controller.unpark(positionMs, wasPlaying);
  }
}
