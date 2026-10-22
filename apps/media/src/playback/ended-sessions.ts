import type { PlaybackSessionId } from "@movies/contracts/ids";
import { PLAYBACK_TOKEN_LIFETIME_MS } from "@movies/contracts/playback-token";
import { Clock, Context, Effect, Layer, Ref } from "effect";

interface EndedSession {
  readonly sessionId: PlaybackSessionId;
  readonly endedAt: number;
}

/** Remembers ended playback sessions. */
export interface Interface {
  readonly isEnded: (sessionId: PlaybackSessionId) => Effect.Effect<boolean>;
  readonly record: (sessions: ReadonlyArray<EndedSession>) => Effect.Effect<void>;
}

/** The ended-session registry. */
export class Service extends Context.Service<Service, Interface>()("@movies/media/EndedSessions") {}

/** An empty in-memory registry; the Convex subscription fills it in production. */
export const layer: Layer.Layer<Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const ended = yield* Ref.make<ReadonlyMap<PlaybackSessionId, number>>(new Map());

    return Service.of({
      isEnded: (sessionId) => Ref.get(ended).pipe(Effect.map((current) => current.has(sessionId))),
      record: Effect.fn("EndedSessions.record")(function* (sessions) {
        const cutoff = (yield* Clock.currentTimeMillis) - PLAYBACK_TOKEN_LIFETIME_MS;

        yield* Ref.update(ended, (current) => {
          const next = new Map([...current].filter(([, endedAt]) => endedAt > cutoff));

          for (const session of sessions) {
            if (session.endedAt > cutoff) next.set(session.sessionId, session.endedAt);
          }

          return next;
        });
      }),
    });
  }),
);
