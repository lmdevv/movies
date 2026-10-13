/**
 * Playback negotiation: verifies the playback token, resolves the token's file on the server,
 * walks the playback ladder for the client's capabilities, starts an HLS session when needed,
 * and returns the URLs to play. Clients never send paths or ffmpeg arguments; everything comes
 * from the token's file ID and the server's own records.
 */
import {
  type FileResolverUnavailable,
  type MediaFileNotFound,
  type NegotiateRequest,
  type NegotiateResponse,
  type PlaybackSessionEnded,
  UnsupportedPlayback,
} from "@movies/contracts/media-playback";
import type { PlaybackTokenInvalid } from "@movies/contracts/playback-token";
import { Context, Duration, Effect, FileSystem, Layer, Option, Path, Redacted } from "effect";

import * as MediaConfig from "../media-config.ts";
import { subtitleTracks } from "../subtitles/subtitle-tracks.ts";
import * as FileResolver from "./file-resolver.ts";
import { resolveInsideRoots } from "./file-resolver.ts";
import * as HardwareAcceleration from "./hardware-acceleration.ts";
import * as KeyframeIndex from "./keyframe-index.ts";
import { AudioPlan, decidePlayback, PlaybackPlan, VideoPlan } from "./playback-decision.ts";
import * as PlaybackReporter from "./playback-reporter.ts";
import * as PlaybackToken from "./playback-token.ts";
import * as StreamSessions from "./stream-sessions.ts";

/** Failures a negotiation can report. */
type NegotiateError =
  | PlaybackTokenInvalid
  | PlaybackSessionEnded
  | MediaFileNotFound
  | FileResolverUnavailable
  | UnsupportedPlayback
  | StreamSessions.StartError;

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

/**
 * How long negotiation waits for a copy's keyframe index before it encodes instead. Matroska and
 * MP4 files answer from their own index at once; a packet scan of a large file on a slow share can
 * take minutes, and it goes on in the background for the next negotiation.
 */
const KEYFRAME_WAIT = Duration.seconds(2);

/** Media URLs carry the token because `<video>` and segment fetches cannot set headers. */
export const withToken = (url: string, token: Redacted.Redacted): string =>
  `${url}?token=${encodeURIComponent(Redacted.value(token))}`;

/** Builds the negotiator. */
const make = Effect.gen(function* () {
  const config = yield* MediaConfig.Service;
  const verifier = yield* PlaybackToken.Service;
  const sessions = yield* StreamSessions.Service;
  const hardware = yield* HardwareAcceleration.Service;
  const reporter = yield* PlaybackReporter.Service;
  const resolver = yield* FileResolver.Service;
  const keyframes = yield* KeyframeIndex.Service;
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

    const decision = {
      audioIndex: request.audioStreamIndex,
      hardwareTranscoding: qsv,
    };

    const preferred = decidePlayback(file.probe, request.capabilities, decision);

    // A copy needs the file's keyframes. When they take long to find, encode on a grid at once if
    // this client can take an encode; else wait for them.
    const copied =
      PlaybackPlan.$is("Hls")(preferred) && VideoPlan.$is("Copy")(preferred.video)
        ? yield* keyframes.keyframesWithin(file, KEYFRAME_WAIT)
        : Option.none<ReadonlyArray<number>>();

    const encoded =
      PlaybackPlan.$is("Hls")(preferred) &&
      VideoPlan.$is("Copy")(preferred.video) &&
      Option.isNone(copied)
        ? decidePlayback(file.probe, request.capabilities, { ...decision, copyVideo: false })
        : undefined;

    const indexing = encoded !== undefined && PlaybackPlan.$is("Hls")(encoded);

    if (indexing) {
      yield* Effect.logInfo("PlaybackNegotiator.encoding_while_indexing").pipe(
        Effect.annotateLogs({ fileId: grant.fileId }),
      );
    }

    const plan = indexing ? encoded : preferred;

    const knownKeyframes =
      PlaybackPlan.$is("Hls")(plan) && VideoPlan.$is("Copy")(plan.video)
        ? Option.getOrUndefined(copied)
        : undefined;

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
      keyframes: knownKeyframes,
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
  | KeyframeIndex.Service
  | FileSystem.FileSystem
  | Path.Path
> = Layer.effect(Service, make);
