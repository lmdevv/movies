/**
 * `PlaybackReporter` over Convex: the mode each playback session runs in (and any later change,
 * such as a QSV failure falling back to software) is recorded with
 * `mediaService:recordPlaybackMode`; stream endings are logged. Events go through a queue that a
 * background fiber drains, so negotiation never waits on Convex; a failed write is logged and
 * dropped, because the next negotiation records the mode again.
 */
import type { CallError } from "@movies/sdk/effect";
import { Effect, Layer, Queue, Stream } from "effect";

import * as PlaybackReporter from "../playback/playback-reporter.ts";
import * as MediaBackend from "./media-backend.ts";

/** Events waiting to be written; beyond this, new events are dropped. */
const QUEUE_CAPACITY = 1024;

/** The reporter over the Convex connection; its writer lives as long as the layer. */
export const layer: Layer.Layer<PlaybackReporter.Service, never, MediaBackend.Service> =
  Layer.effect(
    PlaybackReporter.Service,
    Effect.gen(function* () {
      const backend = yield* MediaBackend.Service;
      const queue = yield* Queue.dropping<PlaybackReporter.PlaybackEvent>(QUEUE_CAPACITY);

      const write = (event: PlaybackReporter.PlaybackEvent): Effect.Effect<void> =>
        PlaybackReporter.PlaybackEvent.match(event, {
          ModeChosen: ({ sessionId, mode }): Effect.Effect<void, CallError> =>
            backend
              .call("mediaService.recordPlaybackMode", { sessionId, mode })
              .pipe(Effect.asVoid),
          ModeChanged: ({ sessionId, to }): Effect.Effect<void, CallError> =>
            backend
              .call("mediaService.recordPlaybackMode", { sessionId, mode: to })
              .pipe(Effect.asVoid),
          StreamEnded: (ended): Effect.Effect<void, CallError> =>
            Effect.logInfo("PlaybackReporter.stream_ended", ended),
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("PlaybackReporter.write_failed", error).pipe(
              Effect.annotateLogs({ sessionId: event.sessionId }),
            ),
          ),
        );

      yield* Stream.fromQueue(queue).pipe(Stream.runForEach(write), Effect.forkScoped);

      return PlaybackReporter.Service.of({
        report: (event) => Queue.offer(queue, event).pipe(Effect.asVoid),
      });
    }),
  );
