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
import type { NegotiateResponse } from "@movies/contracts/media-playback";
import type { StartedPlayback } from "@movies/contracts/models/playback";
import { Milliseconds } from "@movies/contracts/units";
import { Playback } from "@movies/sdk/effect";
import type { MoviesClient } from "@movies/sdk/effect";
import type { useMoviesRuntime } from "@movies/sdk/react";
import { Effect, Exit, Option, Result, Struct } from "effect";

import type { PlaybackController } from "@/playback/playback-controller";

import type { CastLoadRequest, CastSession } from "./cast-api";
import { CastPlayer } from "./cast-player";
import { castLoadPlan, castTrackIds } from "./cast-profile";
import type { CastItem, CastLoadPlan } from "./cast-profile";
import type { CastSdk } from "./cast-sdk";

type Runtime = ReturnType<typeof useMoviesRuntime>;

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

/** Builds the SDK's load request for `plan`. */
const loadRequest = (sdk: CastSdk, plan: CastLoadPlan): CastLoadRequest => {
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

  request.autoplay = true;
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
  #started: StartedPlayback;
  #stream: NegotiateResponse;
  #plan: CastLoadPlan;
  #subtitleId: string | null;
  #audioStreamIndex: number | null;
  #unsubscribe: () => void = () => undefined;
  #stopped = false;

  private constructor(
    runtime: Runtime,
    sdk: CastSdk,
    session: CastSession,
    controller: PlaybackController,
    item: CastItem,
    playing: {
      readonly started: StartedPlayback;
      readonly stream: NegotiateResponse;
      readonly plan: CastLoadPlan;
    },
  ) {
    this.#runtime = runtime;
    this.#sdk = sdk;
    this.#session = session;
    this.#controller = controller;
    this.#item = item;
    this.#started = playing.started;
    this.#stream = playing.stream;
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
   * hands the session's output to the receiver.
   */
  static async start(
    runtime: Runtime,
    sdk: CastSdk,
    session: CastSession,
    controller: PlaybackController,
    item: CastItem,
  ): Promise<Result.Result<CastPlayback, CastFailure>> {
    const snapshot = controller.getSnapshot();
    const started = snapshot.started;

    if (started === null) return Result.fail("not-ready");

    const positionMs = controller.output.positionMs();
    const capabilities = castCapabilities(session.getCastDevice().modelName);

    const negotiated = await run(
      runtime,
      Playback.negotiate(
        started,
        capabilities,
        Milliseconds.make(Math.max(0, positionMs)),
        Option.fromNullishOr(snapshot.audioStreamIndex),
      ),
    );

    if (negotiated === null || Result.isFailure(negotiated)) return Result.fail("unsupported");

    const stream = negotiated.success;
    const plan = castLoadPlan(stream, item, snapshot.subtitleId, positionMs / 1000);
    const failure = await session.loadMedia(loadRequest(sdk, plan)).catch(() => "load-failed");

    if (failure !== undefined) {
      await run(runtime, Playback.stop({ started, stream }));

      return Result.fail("load-failed");
    }

    const cast = new CastPlayback(runtime, sdk, session, controller, item, {
      started,
      stream,
      plan,
    });

    cast.#begin();

    return Result.succeed(cast);
  }

  #begin(): void {
    // The receiver plays now; the page's element waits, and only the receiver's events count.
    this.#controller.output.switchTo(this.player);
    this.#controller.player.pause();
    this.#unsubscribe = this.#controller.subscribe(this.#onSnapshot);
  }

  /** Follows the page's subtitle and audio choices and its token renewals. */
  readonly #onSnapshot = (): void => {
    const { started, subtitleId, audioStreamIndex } = this.#controller.getSnapshot();

    if (this.#stopped) return;

    if (subtitleId !== this.#subtitleId) {
      this.#subtitleId = subtitleId;
      this.#showSubtitle(subtitleId);
    }

    const renewed = started !== null && started.token !== this.#started.token;

    if (renewed || audioStreamIndex !== this.#audioStreamIndex) {
      this.#audioStreamIndex = audioStreamIndex;
      void this.#reload(started ?? this.#started, this.player.positionMs());
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

  /** Negotiates again with `started` (a renewed token, another audio track) and reloads. */
  async #reload(started: StartedPlayback, positionMs: number): Promise<void> {
    const negotiated = await run(
      this.#runtime,
      Playback.negotiate(
        started,
        castCapabilities(this.#session.getCastDevice().modelName),
        Milliseconds.make(Math.max(0, positionMs)),
        Option.fromNullishOr(this.#audioStreamIndex),
      ),
    );

    if (this.#stopped || negotiated === null || Result.isFailure(negotiated)) return;

    const previous = { started: this.#started, stream: this.#stream };

    this.#started = started;
    this.#stream = negotiated.success;
    await this.#load(positionMs);

    // The old stream's segments are no longer needed.
    if (previous.stream.streamId !== this.#stream.streamId)
      void run(this.#runtime, Playback.stop(previous));
  }

  /** Loads the current stream on the receiver at `positionMs`, keeping play or pause. */
  async #load(positionMs: number): Promise<void> {
    const paused = this.player.isPaused();

    this.#plan = castLoadPlan(this.#stream, this.#item, this.#subtitleId, positionMs / 1000);
    await this.#session.loadMedia(loadRequest(this.#sdk, this.#plan)).catch(() => undefined);

    if (paused) this.player.pause();
  }

  /** Moves the receiver to `positionMs`: in place for a direct file or a produced position. */
  async #moveTo(positionMs: number, signal: AbortSignal): Promise<void> {
    const playback = { started: this.#started, stream: this.#stream };

    if (this.#stream.streamId === undefined) {
      this.player.seekInPlace(positionMs);

      return;
    }

    const moved = await run(
      this.#runtime,
      Playback.seekStream(playback, Milliseconds.make(positionMs)),
    );

    if (signal.aborted || this.#stopped) return;

    if (moved === null || Result.isFailure(moved)) {
      // The stream is gone (a restart, an idle timeout): negotiate a new one there.
      await this.#reload(this.#started, positionMs);

      return;
    }

    const next = Option.getOrUndefined(moved.success);

    if (next === undefined || next.generation === this.#stream.generation) {
      this.player.seekInPlace(positionMs);

      return;
    }

    this.#stream = Struct.evolve(this.#stream, {
      url: () => next.playlistUrl,
      generation: () => next.generation,
    });
    await this.#load(positionMs);
  }

  /**
   * Ends the cast on the page's side: the output goes back to the element, the receiver's stream
   * stops, and, with `resume`, the page plays on from where the TV was. The cast session itself is
   * the caller's to end.
   */
  stop(resume: boolean): void {
    if (this.#stopped) return;
    this.#stopped = true;

    const positionMs = this.player.positionMs();
    const wasPlaying = !this.player.isPaused();

    this.#unsubscribe();
    this.player.dispose();
    this.#controller.output.switchTo(this.#controller.player);
    void run(this.#runtime, Playback.stop({ started: this.#started, stream: this.#stream }));

    if (!resume) return;
    this.#controller.player.seek(positionMs);

    if (wasPlaying) this.#controller.resumeWithGesture();
  }
}
