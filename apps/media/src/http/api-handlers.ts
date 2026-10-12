/** Handlers of the media HttpApi. */
import { Effect, Layer } from "effect";
import { HttpApiBuilder } from "effect/http-api";

import * as MediaConfig from "../media-config.ts";
import * as HardwareAcceleration from "../playback/hardware-acceleration.ts";
import * as PlaybackNegotiator from "../playback/playback-negotiator.ts";
import { withToken } from "../playback/playback-negotiator.ts";
import * as PlaybackToken from "../playback/playback-token.ts";
import * as StreamSessions from "../playback/stream-sessions.ts";
import { MediaApi } from "./media-api.ts";

/** Playback endpoints. */
export const playbackHandlers = HttpApiBuilder.group(
  MediaApi,
  "playback",
  Effect.fn(function* (handlers) {
    const config = yield* MediaConfig.Service;
    const negotiator = yield* PlaybackNegotiator.Service;
    const verifier = yield* PlaybackToken.Service;
    const sessions = yield* StreamSessions.Service;

    return handlers.handleAll({
      negotiate: ({ payload }) => negotiator.negotiate(payload),
      seek: Effect.fn("Api.seek")(function* ({ payload }) {
        const grant = yield* verifier.verify(payload.token);
        const view = yield* sessions.seek(payload.streamId, payload.positionSeconds, grant);

        return {
          streamId: view.streamId,
          generation: view.generation,
          playlistUrl: withToken(
            `${config.mediaBaseUrl}/media/hls/${view.streamId}/${view.generation}/index.m3u8`,
            payload.token,
          ),
        };
      }),
      stop: Effect.fn("Api.stop")(function* ({ payload }) {
        const grant = yield* verifier.verify(payload.token);
        yield* sessions.stop(payload.streamId, grant);
      }),
    });
  }),
);

/** System endpoints. */
export const systemHandlers = HttpApiBuilder.group(
  MediaApi,
  "system",
  Effect.fn(function* (handlers) {
    const sessions = yield* StreamSessions.Service;
    const hardware = yield* HardwareAcceleration.Service;

    return handlers.handleAll({
      health: Effect.fn("Api.health")(function* () {
        return {
          status: "ok" as const,
          activeStreams: yield* sessions.activeCount,
          hardwareAcceleration: (yield* hardware.qsvAvailable)
            ? ("qsv" as const)
            : ("none" as const),
        };
      }),
    });
  }),
);

/** The API routes with their handlers. */
export const apiLayer = HttpApiBuilder.layer(MediaApi).pipe(
  Layer.provide([playbackHandlers, systemHandlers]),
);
