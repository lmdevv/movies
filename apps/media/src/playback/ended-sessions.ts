import type { PlaybackSessionId } from "@movies/contracts/ids";
import {
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  Layer,
  Option,
  Ref,
  ScopedCache,
  Stream,
} from "effect";

import * as SessionReports from "./session-reports.ts";
import { SessionReport } from "./stream-liveness.ts";

/** Tells ended playback sessions apart. */
export interface Interface {
  /**
   * Whether `sessionId` ended, or the owner of playback sessions has no such session. Questions
   * asked within five seconds of the first about a session wait for the owner's answer; without
   * one they answer no, and a later question hears the answer once it comes.
   */
  readonly isEnded: (sessionId: PlaybackSessionId) => Effect.Effect<boolean>;
}

/** The ended-session registry. */
export class Service extends Context.Service<Service, Interface>()("@movies/media/EndedSessions") {}

const ANSWER_WAIT = Duration.seconds(5);

/**
 * Sessions remembered at once; past it, the one asked about least recently is forgotten and
 * followed again when next asked about.
 */
const CAPACITY = 4096;

/**
 * Follows each session it is asked about through the owner's report on that session alone, until
 * the session ends. Following the session itself, rather than a feed of ends ordered by when they
 * were stamped, sees an end however late it commits and wherever a restore or a clock step puts
 * its stamp, and no end waits on another session's.
 */
export const layer: Layer.Layer<Service, never, SessionReports.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const reports = yield* SessionReports.Service;

    const follow = Effect.fnUntraced(function* (sessionId: PlaybackSessionId) {
      const ended = yield* Ref.make(false);
      const answered = yield* Deferred.make<void>();
      const answerBy = (yield* Clock.currentTimeMillis) + Duration.toMillis(ANSWER_WAIT);

      yield* reports.follow(sessionId).pipe(
        Stream.takeUntil(SessionReport.$is("Ended")),
        Stream.runForEach((report) =>
          Ref.set(ended, SessionReport.$is("Ended")(report)).pipe(
            Effect.andThen(Deferred.succeed(answered, undefined)),
          ),
        ),
        Effect.forkScoped,
      );

      yield* Deferred.await(answered).pipe(
        Effect.timeoutOption(ANSWER_WAIT),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.logWarning("EndedSessions.unanswered").pipe(
                Effect.annotateLogs({ sessionId }),
              ),
            onSome: () => Effect.void,
          }),
        ),
        Effect.forkScoped,
      );

      return { ended, answered, answerBy };
    });

    const followed = yield* ScopedCache.make({ lookup: follow, capacity: CAPACITY });

    return Service.of({
      isEnded: Effect.fn("EndedSessions.isEnded")(function* (sessionId) {
        const session = yield* ScopedCache.get(followed, sessionId);
        const wait = session.answerBy - (yield* Clock.currentTimeMillis);

        if (wait > 0) {
          yield* Deferred.await(session.answered).pipe(Effect.timeoutOption(Duration.millis(wait)));
        }

        return yield* Ref.get(session.ended);
      }),
    });
  }),
);

/** Standalone mode: no one owns playback sessions, so none ends. */
export const layerNone: Layer.Layer<Service> = Layer.succeed(
  Service,
  Service.of({ isEnded: () => Effect.succeed(false) }),
);
