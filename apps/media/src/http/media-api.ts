/**
 * The media service's Effect HttpApi: playback negotiation and stream control, plus health.
 * Media bytes (direct files, HLS playlists and segments, WebVTT) are plain router routes in
 * `media-routes.ts`, because `<video>` elements and HLS players fetch them by URL. This
 * definition is self-contained so it can move into `@movies/contracts` for the SDK.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";

import { StreamId } from "../ids.ts";
import { FileResolverUnavailable, MediaFileNotFound } from "../playback/file-resolver.ts";
import { KeyframeIndexFailed } from "../playback/keyframe-index.ts";
import { UnsupportedPlayback } from "../playback/playback-decision.ts";
import { NegotiateRequest, NegotiateResponse } from "../playback/playback-negotiator.ts";
import { InvalidPlaybackToken } from "../playback/playback-token.ts";
import {
  InsufficientTranscodeSpace,
  SegmentNotFound,
  SegmentNotReady,
  StreamAccessDenied,
  StreamGenerationGone,
  StreamNotFound,
  TranscodeCapacityReached,
  TranscodeFailed,
} from "../playback/stream-sessions.ts";

/** A request that moves an HLS stream to another position. */
const SeekRequest = Schema.Struct({
  token: Schema.Redacted(Schema.String),
  streamId: StreamId,
  positionSeconds: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
});

/** Where the stream continues: the generation to load and its playlist. */
const SeekResponse = Schema.Struct({
  streamId: StreamId,
  generation: Schema.Int,
  playlistUrl: Schema.String,
});

/** A request that ends an HLS stream and deletes its temporary output. */
const StopRequest = Schema.Struct({
  token: Schema.Redacted(Schema.String),
  streamId: StreamId,
});

/** Service health. */
export const HealthResponse = Schema.Struct({
  status: Schema.Literal("ok"),
  activeStreams: Schema.Int,
  hardwareAcceleration: Schema.Literals(["qsv", "none"]),
});

const streamErrors = [
  InvalidPlaybackToken,
  StreamNotFound,
  StreamAccessDenied,
  StreamGenerationGone,
  SegmentNotFound,
  SegmentNotReady,
  TranscodeFailed,
  UnsupportedPlayback,
] as const;

/** Playback negotiation and HLS stream control. */
class PlaybackGroup extends HttpApiGroup.make("playback")
  .add(
    HttpApiEndpoint.post("negotiate", "/negotiate", {
      payload: NegotiateRequest,
      success: NegotiateResponse,
      error: [
        InvalidPlaybackToken,
        MediaFileNotFound,
        FileResolverUnavailable,
        UnsupportedPlayback,
        TranscodeCapacityReached,
        InsufficientTranscodeSpace,
        TranscodeFailed,
        KeyframeIndexFailed,
      ],
    }),
    HttpApiEndpoint.post("seek", "/seek", {
      payload: SeekRequest,
      success: SeekResponse,
      error: streamErrors,
    }),
    HttpApiEndpoint.post("stop", "/stop", {
      payload: StopRequest,
      success: HttpApiSchema.NoContent,
      error: [InvalidPlaybackToken, StreamNotFound, StreamAccessDenied],
    }),
  )
  .prefix("/api/playback") {}

/** Liveness and capability summary. */
class SystemGroup extends HttpApiGroup.make("system")
  .add(HttpApiEndpoint.get("health", "/health", { success: HealthResponse }))
  .prefix("/api") {}

/** The media service API. */
export class MediaApi extends HttpApi.make("media").add(PlaybackGroup).add(SystemGroup) {}
