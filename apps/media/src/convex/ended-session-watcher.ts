import { EpochMillis } from "@movies/contracts/units";
import { PLAYBACK_TOKEN_LIFETIME_MS } from "@movies/contracts/playback-token";
import { Clock, Effect, Layer, Option, Stream } from "effect";

import * as EndedSessions from "../playback/ended-sessions.ts";
import * as StreamSessions from "../playback/stream-sessions.ts";
import * as MediaBackend from "./media-backend.ts";

const BATCH = 200;

/** Watches ended sessions for the lifetime of the layer. */
export const layer: Layer.Layer<
  never,
  never,
  MediaBackend.Service | EndedSessions.Service | StreamSessions.Service
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const backend = yield* MediaBackend.Service;
    const ended = yield* EndedSessions.Service;
    const streams = yield* StreamSessions.Service;

    const follow = (after: number): Effect.Effect<never> =>
      backend
        .subscribe("mediaService.endedSessions", { after: EpochMillis.make(after), limit: BATCH })
        .pipe(
          Stream.filter((sessions) => sessions.length > 0),
          Stream.runHead,
          Effect.flatMap(
            Option.match({
              onNone: () => follow(after),
              onSome: (sessions) =>
                Effect.gen(function* () {
                  yield* ended.record(sessions);

                  const closed = yield* Effect.forEach(sessions, (session) =>
                    streams.closeStreams(session.sessionId, "session-ended"),
                  );

                  const stopped = closed.reduce((total, count) => total + count, 0);

                  if (stopped > 0) {
                    yield* Effect.logInfo("EndedSessionWatcher.streams_stopped").pipe(
                      Effect.annotateLogs({ streams: stopped }),
                    );
                  }

                  return yield* follow(Math.max(after, ...sessions.map((s) => s.endedAt)));
                }),
            }),
          ),
        );

    const now = yield* Clock.currentTimeMillis;

    yield* Effect.forkScoped(follow(Math.max(0, now - PLAYBACK_TOKEN_LIFETIME_MS)));
  }),
);
