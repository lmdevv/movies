/** Handlers of the media HttpApi. */
import { MediaApi } from "@movies/contracts/media-api";
import { Effect, Layer, Option } from "effect";
import { HttpApiBuilder } from "effect/http-api";

import * as BackendHealth from "../backend-health.ts";
import * as MediaConfig from "../media-config.ts";
import * as HardwareAcceleration from "../playback/hardware-acceleration.ts";
import * as PlaybackNegotiator from "../playback/playback-negotiator.ts";
import { withToken } from "../playback/playback-negotiator.ts";
import * as PlaybackToken from "../playback/playback-token.ts";
import * as StreamSessions from "../playback/stream-sessions.ts";

/** Playback endpoints. */
const playbackHandlers = HttpApiBuilder.group(
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
const systemHandlers = HttpApiBuilder.group(
  MediaApi,
  "system",
  Effect.fn(function* (handlers) {
    const sessions = yield* StreamSessions.Service;
    const hardware = yield* HardwareAcceleration.Service;
    const backend = yield* BackendHealth.Service;
    const config = yield* MediaConfig.Service;

    return handlers.handleAll({
      health: Effect.fn("Api.health")(function* () {
        return {
          status: "ok" as const,
          activeStreams: yield* sessions.activeCount,
          hardwareAcceleration: (yield* hardware.encoder) ?? ("none" as const),
          backend: yield* backend.status,
        };
      }),
      clientConfig: () =>
        Effect.succeed(
          // Only the public address: the internal one (a container name, a loopback) is often
          // unreachable from phones, and apps fall back to Connection Details without it.
          Option.match(config.convexPublicUrl, {
            onNone: () => ({}),
            onSome: (url) => ({ convexUrl: url }),
          }),
        ),
    });
  }),
);

/** The API routes with their handlers. */
export const apiLayer = HttpApiBuilder.layer(MediaApi).pipe(
  Layer.provide([playbackHandlers, systemHandlers]),
);
