/**
 * Playing a movie or an episode on this device: start a playback session in Convex, negotiate a
 * stream with the media service, and report progress while it plays. Watched marks happen on the
 * server at 90 percent; the client only reports what it actually played.
 *
 * The media service's playback API is an Effect HttpApi that has not moved into the contracts
 * yet. The request and response schemas here mirror its `POST /api/playback/negotiate`, `seek`,
 * and `stop` routes and keep only the fields clients use.
 */
import type {
  DeviceId,
  EpisodeId,
  MediaFileId,
  ProfileId,
  RoomId,
  TitleId,
} from "@movies/contracts/ids";
import type { Episode } from "@movies/contracts/models/catalog";
import type {
  ProgressEvent,
  ProgressReceipt,
  StartedPlayback,
} from "@movies/contracts/models/playback";
import { Milliseconds } from "@movies/contracts/units";
import { Duration, Effect, Option, Redacted, Schedule, Schema, Stream } from "effect";

import { requestJson } from "./media-http";
import { MoviesClient } from "./movies-client";
import type { PlayerEvent, PlayerPort } from "./room-sync/player-port";
import { playerEvents } from "./room-sync/player-port";
import type { CallError } from "./sdk-errors";

/** A video codec the device decodes. Names follow ffmpeg (`h264`, `hevc`, `av1`, `vp9`). */
const VideoCodecSupport = Schema.Struct({
  codec: Schema.String,
  profiles: Schema.optionalKey(Schema.Array(Schema.String)),
  maxLevel: Schema.optionalKey(Schema.Int),
  maxBitDepth: Schema.optionalKey(Schema.Int),
  dynamicRanges: Schema.optionalKey(
    Schema.Array(Schema.Literals(["sdr", "hdr10", "hlg", "dolby-vision"])),
  ),
});

/** What the device can play. Browser checks are hints; a failed direct stream renegotiates. */
export const ClientCapabilities = Schema.Struct({
  /** Containers played progressively over byte ranges, such as `mp4` or `webm`. */
  containers: Schema.Array(Schema.Literals(["mp4", "mov", "mkv", "webm", "avi", "ts", "other"])),
  videoCodecs: Schema.Array(VideoCodecSupport),
  audioCodecs: Schema.Array(
    Schema.Struct({ codec: Schema.String, maxChannels: Schema.optionalKey(Schema.Int) }),
  ),
  maxWidth: Schema.Int,
  maxHeight: Schema.Int,
  /** Plays HLS natively (Safari, TVs). */
  hls: Schema.Boolean,
  /** Has Media Source Extensions, so a script player such as hls.js can play fMP4 HLS. */
  mse: Schema.Boolean,
});

/** What the device can play. */
export interface ClientCapabilities extends Schema.Schema.Type<typeof ClientCapabilities> {}

/** A stream the media service negotiated for this device. */
export const NegotiatedStream = Schema.Struct({
  /** `direct` plays the file over byte ranges; the other modes are HLS. */
  mode: Schema.String,
  /** The file URL or the HLS playlist URL, with the playback token in its query. */
  url: Schema.String,
  /** HLS only: the stream and generation the playlist belongs to. */
  streamId: Schema.optionalKey(Schema.String),
  generation: Schema.optionalKey(Schema.Int),
  startSeconds: Schema.Finite,
  durationSeconds: Schema.Finite,
  subtitles: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      kind: Schema.String,
      language: Schema.optionalKey(Schema.String),
      title: Schema.optionalKey(Schema.String),
      forced: Schema.Boolean,
      default: Schema.Boolean,
      url: Schema.optionalKey(Schema.String),
    }),
  ),
  /** When the playback token expires; renegotiate before then. */
  expiresAt: Schema.Finite,
});

/** A negotiated stream. */
export interface NegotiatedStream extends Schema.Schema.Type<typeof NegotiatedStream> {}

/** Where an HLS stream continues after a seek. */
const SeekedStream = Schema.Struct({
  streamId: Schema.String,
  generation: Schema.Int,
  playlistUrl: Schema.String,
});

const mediaUrl = (started: StartedPlayback, path: string): string =>
  `${started.mediaBaseUrl.replace(/\/+$/u, "")}${path}`;

/** What to play. Omitted options pick the best file and resume from saved progress. */
export interface PlaybackRequest {
  readonly profileId: ProfileId;
  readonly deviceId: DeviceId;
  readonly deviceName: Option.Option<string>;
  readonly titleId: TitleId;
  readonly episodeId: Option.Option<EpisodeId>;
  readonly fileId: Option.Option<MediaFileId>;
  /** Join a room's stream; the room decides the file and the position. */
  readonly roomId: Option.Option<RoomId>;
  readonly capabilities: ClientCapabilities;
  /** Start here instead of the saved progress. */
  readonly startAtMs: Option.Option<Milliseconds>;
}

/** A playing session on this device. */
export interface Playback {
  readonly started: StartedPlayback;
  readonly stream: NegotiatedStream;
}

const encodeCapabilities = Schema.encodeEffect(Schema.toCodecJson(ClientCapabilities));

/** Asks the media service for a stream of a started session's file. */
export const negotiate = Effect.fn("Playback.negotiate")(function* (
  started: StartedPlayback,
  capabilities: ClientCapabilities,
  startAtMs: Milliseconds,
) {
  return yield* requestJson(
    {
      operation: "playback.negotiate",
      url: mediaUrl(started, "/api/playback/negotiate"),
      method: "POST",
      body: Option.some({
        token: Redacted.value(Redacted.make(started.token)),
        capabilities: yield* encodeCapabilities(capabilities).pipe(Effect.orDie),
        startSeconds: startAtMs / 1000,
      }),
      bearer: Option.none(),
    },
    NegotiatedStream,
  );
});

/** Moves an HLS stream to `positionMs`; returns the playlist to load next. */
export const seekStream = Effect.fn("Playback.seekStream")(function* (
  playback: Playback,
  positionMs: Milliseconds,
) {
  const streamId = Option.fromNullishOr(playback.stream.streamId);

  if (Option.isNone(streamId)) return Option.none<typeof SeekedStream.Type>();

  return Option.some(
    yield* requestJson(
      {
        operation: "playback.seek",
        url: mediaUrl(playback.started, "/api/playback/seek"),
        method: "POST",
        body: Option.some({
          token: playback.started.token,
          streamId: streamId.value,
          positionSeconds: positionMs / 1000,
        }),
        bearer: Option.none(),
      },
      SeekedStream,
    ),
  );
});

/** Ends an HLS stream so the media service can stop encoding and delete its segments. */
const stopStream = (playback: Playback): Effect.Effect<void, CallError> =>
  Option.match(Option.fromNullishOr(playback.stream.streamId), {
    onNone: () => Effect.void,
    onSome: (streamId) =>
      requestJson(
        {
          operation: "playback.stop",
          url: mediaUrl(playback.started, "/api/playback/stop"),
          method: "POST",
          body: Option.some({ token: playback.started.token, streamId }),
          bearer: Option.none(),
        },
        Schema.Null,
      ).pipe(Effect.asVoid),
  });

/**
 * Starts playing: creates the session (which ends this device's previous one), then negotiates
 * a stream at the requested position, the saved progress, or the room's start.
 */
export const start = Effect.fn("Playback.start")(function* (request: PlaybackRequest) {
  const client = yield* MoviesClient;

  const started = yield* client.mutate("playback.createSession", {
    profileId: request.profileId,
    deviceId: request.deviceId,
    titleId: request.titleId,
    ...Option.match(request.deviceName, {
      onNone: () => ({}),
      onSome: (deviceName) => ({ deviceName }),
    }),
    ...Option.match(request.episodeId, {
      onNone: () => ({}),
      onSome: (episodeId) => ({ episodeId }),
    }),
    ...Option.match(request.fileId, { onNone: () => ({}), onSome: (fileId) => ({ fileId }) }),
    ...Option.match(request.roomId, { onNone: () => ({}), onSome: (roomId) => ({ roomId }) }),
  });

  const startAt = Option.getOrElse(request.startAtMs, () => started.resumePositionMs);
  const stream = yield* negotiate(started, request.capabilities, startAt);
  const playback: Playback = { started, stream };

  return playback;
});

/** How often a playing device reports progress between events. */
export const PROGRESS_INTERVAL_MS = 10_000;

/** How long the final report on exit may take before it is abandoned. */
const EXIT_REPORT_TIMEOUT_MS = 2_000;

const EVENT_REPORTS: Readonly<Record<PlayerEvent, ProgressEvent | null>> = {
  playing: "resume",
  paused: "pause",
  seeked: "seek",
  ended: "ended",
  waiting: null,
};

const position = (player: PlayerPort): Milliseconds =>
  Milliseconds.make(Math.max(0, player.positionMs()));

/**
 * Reports progress for a playing session until its scope closes: every ten seconds while
 * playing, and on pause, resume, seek, and end. Closing the scope ends the session and its HLS
 * stream on a best-effort basis. Report failures are logged and skipped; the next report retries.
 */
export const reportProgress = Effect.fn("Playback.reportProgress")(function* (
  playback: Playback,
  player: PlayerPort,
) {
  const client = yield* MoviesClient;
  const sessionId = playback.started.sessionId;

  const report = (event: ProgressEvent): Effect.Effect<Option.Option<ProgressReceipt>> =>
    client
      .mutate("playback.reportProgress", { sessionId, positionMs: position(player), event })
      .pipe(
        Effect.asSome,
        Effect.catch((error) =>
          Effect.logWarning("Playback.reportFailed", error).pipe(
            Effect.annotateLogs({ sessionId, event }),
            Effect.as(Option.none()),
          ),
        ),
      );

  const events = yield* playerEvents(player);

  yield* Effect.addFinalizer(() =>
    Effect.all(
      [
        client.mutate("playback.endSession", { sessionId, positionMs: position(player) }),
        stopStream(playback),
      ],
      { concurrency: "unbounded", discard: true },
    ).pipe(Effect.timeout(Duration.millis(EXIT_REPORT_TIMEOUT_MS)), Effect.ignore),
  );

  yield* Effect.forkScoped(
    Stream.runForEach(events, (event) => {
      const kind = EVENT_REPORTS[event];

      return kind === null ? Effect.void : report(kind);
    }),
  );

  yield* Effect.forkScoped(
    Effect.repeat(
      Effect.suspend(() => (player.isPaused() ? Effect.void : report("tick"))).pipe(
        Effect.delay(Duration.millis(PROGRESS_INTERVAL_MS)),
      ),
      Schedule.forever,
    ),
  );
});

/** The episode after `episodeId` for this profile, or none after the last one. */
export const nextEpisode = Effect.fn("Playback.nextEpisode")(function* (
  profileId: ProfileId,
  episodeId: EpisodeId,
) {
  const client = yield* MoviesClient;

  const next: Episode | null = yield* client.query("playback.nextEpisode", {
    profileId,
    episodeId,
  });

  return Option.fromNullishOr(next);
});

/**
 * An autoplay countdown: the remaining time now and then every `stepMs` until zero. Play the next
 * episode when it completes; interrupt it to cancel.
 */
export const autoplayCountdown = (totalMs: number, stepMs: number): Stream.Stream<Milliseconds> => {
  const steps = Math.ceil(Math.max(0, totalMs) / stepMs);

  return Stream.fromEffectSchedule(Effect.void, Schedule.spaced(Duration.millis(stepMs))).pipe(
    Stream.take(steps + 1),
    Stream.zipWithIndex,
    Stream.map(([, index]) => Milliseconds.make(Math.max(0, totalMs - index * stepMs))),
  );
};
