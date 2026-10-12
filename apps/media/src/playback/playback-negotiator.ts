/**
 * Playback negotiation: verifies the playback token, resolves the token's file on the server,
 * walks the playback ladder for the client's capabilities, starts an HLS session when needed,
 * and returns the URLs to play. Clients never send paths or ffmpeg arguments; everything comes
 * from the token's file ID and the server's own records.
 */
import { Context, Effect, FileSystem, Layer, Path, Redacted, Schema } from "effect";

import { StreamId } from "../ids.ts";
import * as MediaConfig from "../media-config.ts";
import { DynamicRange } from "../media/media-probe.ts";
import { SubtitleTrack, subtitleTracks } from "../subtitles/subtitle-tracks.ts";
import * as FileResolver from "./file-resolver.ts";
import { resolveInsideRoots } from "./file-resolver.ts";
import * as HardwareAcceleration from "./hardware-acceleration.ts";
import type { KeyframeIndexFailed } from "./keyframe-index.ts";
import {
  AudioPlan,
  ClientCapabilities,
  decidePlayback,
  PlaybackMode,
  PlaybackPlan,
  UnsupportedPlayback,
  VideoPlan,
} from "./playback-decision.ts";
import * as PlaybackReporter from "./playback-reporter.ts";
import * as PlaybackToken from "./playback-token.ts";
import * as StreamSessions from "./stream-sessions.ts";

/** A negotiation request. */
export const NegotiateRequest = Schema.Struct({
  /** The playback token Convex issued for this file and device session. */
  token: Schema.Redacted(Schema.String),
  capabilities: ClientCapabilities,
  /** ffmpeg stream index of the audio track to play; the default track when absent. */
  audioStreamIndex: Schema.optional(Schema.Int),
  /** Where playback starts, in seconds from the beginning. */
  startSeconds: Schema.optional(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
});

/** A negotiation request. */
export interface NegotiateRequest extends Schema.Schema.Type<typeof NegotiateRequest> {}

/** A subtitle track with its WebVTT URL, or the reason it cannot be shown. */
export const NegotiatedSubtitle = Schema.Struct({
  ...SubtitleTrack.fields,
  /** WebVTT URL; absent for bitmap tracks, which are not supported yet. */
  url: Schema.optional(Schema.String),
});

/** The negotiated playback. */
export const NegotiateResponse = Schema.Struct({
  mode: PlaybackMode,
  /** The direct file URL (byte ranges) or the HLS playlist URL. */
  url: Schema.String,
  /** HLS only: the stream and generation the playlist belongs to. */
  streamId: Schema.optional(StreamId),
  generation: Schema.optional(Schema.Int),
  /** Where playback should start; HLS sessions start producing here. */
  startSeconds: Schema.Finite,
  durationSeconds: Schema.Finite,
  video: Schema.Struct({
    codec: Schema.String,
    width: Schema.Int,
    height: Schema.Int,
    dynamicRange: DynamicRange,
  }),
  audio: Schema.optional(
    Schema.Struct({ streamIndex: Schema.Int, codec: Schema.String, channels: Schema.Int }),
  ),
  subtitles: Schema.Array(NegotiatedSubtitle),
  /** Token expiry in milliseconds since the epoch; renegotiate before it. */
  expiresAt: Schema.Finite,
});

/** The negotiated playback. */
export interface NegotiateResponse extends Schema.Schema.Type<typeof NegotiateResponse> {}

/** Failures a negotiation can report. */
export type NegotiateError =
  | PlaybackToken.InvalidPlaybackToken
  | FileResolver.MediaFileNotFound
  | FileResolver.FileResolverUnavailable
  | UnsupportedPlayback
  | StreamSessions.StartError
  | KeyframeIndexFailed;

/** Negotiates playback. */
export interface Interface {
  readonly negotiate: (
    request: NegotiateRequest,
  ) => Effect.Effect<NegotiateResponse, NegotiateError>;
}

/** The playback negotiator. */
export class Service extends Context.Service<Service, Interface>()(
  "@movies/media/PlaybackNegotiator",
) {}

/** Media URLs carry the token because `<video>` and segment fetches cannot set headers. */
export const withToken = (url: string, token: Redacted.Redacted): string =>
  `${url}?token=${encodeURIComponent(Redacted.value(token))}`;

/** Builds the negotiator. */
export const make = Effect.gen(function* () {
  const config = yield* MediaConfig.Service;
  const verifier = yield* PlaybackToken.Service;
  const sessions = yield* StreamSessions.Service;
  const hardware = yield* HardwareAcceleration.Service;
  const reporter = yield* PlaybackReporter.Service;
  const resolver = yield* FileResolver.Service;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const negotiate = Effect.fn("PlaybackNegotiator.negotiate")(function* (
    request: NegotiateRequest,
  ) {
    const grant = yield* verifier.verify(request.token);

    const file = yield* resolveInsideRoots(grant.fileId).pipe(
      Effect.provideService(FileResolver.Service, resolver),
      Effect.provideService(MediaConfig.Service, config),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );

    yield* Effect.annotateCurrentSpan({ fileId: grant.fileId, sessionId: grant.sessionId });
    const qsv = yield* hardware.qsvAvailable;

    const plan = decidePlayback(file.probe, request.capabilities, {
      audioIndex: request.audioStreamIndex,
      hardwareTranscoding: qsv,
    });

    const video = file.probe.video;

    if (PlaybackPlan.$is("Unsupported")(plan) || video === undefined) {
      return yield* new UnsupportedPlayback({
        reason: PlaybackPlan.$is("Unsupported")(plan) ? plan.reason : "no-video-stream",
      });
    }

    const startSeconds = Math.min(
      request.startSeconds ?? 0,
      Math.max(0, file.probe.durationSeconds - 1),
    );

    const base = config.mediaBaseUrl;

    const subtitles = subtitleTracks(file).map((track) => ({
      id: track.id,
      source: track.source,
      codec: track.codec,
      kind: track.kind,
      language: track.language,
      title: track.title,
      forced: track.forced,
      default: track.default,
      hearingImpaired: track.hearingImpaired,
      url:
        track.kind === "text"
          ? withToken(`${base}/media/subtitles/${grant.fileId}/${track.id}.vtt`, request.token)
          : undefined,
    }));

    const audioIndex = PlaybackPlan.$is("Direct")(plan)
      ? plan.audioIndex
      : PlaybackPlan.$is("Hls")(plan) && "index" in plan.audio
        ? plan.audio.index
        : undefined;

    const sourceAudio = file.probe.audio.find((track) => track.index === audioIndex);
    const transcodedAudio = PlaybackPlan.$is("Hls")(plan) && AudioPlan.$is("Aac")(plan.audio);

    const common = {
      durationSeconds: file.probe.durationSeconds,
      startSeconds,
      video: {
        codec: video.codec,
        width: video.width,
        height: video.height,
        dynamicRange: video.dynamicRange,
      },
      audio:
        sourceAudio === undefined
          ? undefined
          : {
              streamIndex: sourceAudio.index,
              codec: transcodedAudio ? "aac" : sourceAudio.codec,
              channels: transcodedAudio ? 2 : sourceAudio.channels,
            },
      subtitles,
      expiresAt: grant.expiresAt,
    };

    if (PlaybackPlan.$is("Direct")(plan)) {
      yield* reporter.report(
        PlaybackReporter.PlaybackEvent.cases.ModeChosen.make({
          sessionId: grant.sessionId,
          fileId: grant.fileId,
          mode: "direct",
        }),
      );

      return {
        ...common,
        mode: "direct",
        url: withToken(`${base}/media/direct/${grant.fileId}`, request.token),
      } satisfies NegotiateResponse;
    }

    const started = yield* sessions.start({
      grant,
      file,
      plan,
      client: request.capabilities,
      audioIndex: request.audioStreamIndex,
      startSeconds,
    });

    const outputVideo =
      VideoPlan.$is("Encode")(plan.video) &&
      started.mode !== "remux" &&
      started.mode !== "audio-transcode"
        ? {
            codec: "h264",
            width: plan.video.width,
            height: plan.video.height,
            dynamicRange: "sdr" as const,
          }
        : common.video;

    return {
      ...common,
      video: outputVideo,
      mode: started.mode,
      streamId: started.streamId,
      generation: started.generation,
      url: withToken(
        `${base}/media/hls/${started.streamId}/${started.generation}/index.m3u8`,
        request.token,
      ),
    } satisfies NegotiateResponse;
  });

  return Service.of({ negotiate });
});

/** The negotiator. */
export const layer: Layer.Layer<
  Service,
  never,
  | MediaConfig.Service
  | PlaybackToken.Service
  | StreamSessions.Service
  | HardwareAcceleration.Service
  | PlaybackReporter.Service
  | FileResolver.Service
  | FileSystem.FileSystem
  | Path.Path
> = Layer.effect(Service, make);
