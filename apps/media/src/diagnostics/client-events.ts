/**
 * Players' diagnostic events (`POST /api/playback/diagnostics`). Each batch is authenticated by
 * its playback token, limited per playback session and per account, and written into the retained
 * log as `Player.*` records carrying the session, the account, and the platform from the verified
 * token and request. An event's stream is the player's claim: it is filed under `streamId` only
 * when the stream belongs to the token's session (`StreamOwners`), and kept as `claimedStreamId`
 * otherwise, where no stream filter finds it. An event says how long before its batch it
 * happened, so its time (`occurredAt`) comes from the service's clock, never the device's.
 */
import {
  type ClientDiagnosticEvent,
  type ClientDiagnosticsRequest,
  DiagnosticsRateLimited,
  PlayerObservation,
} from "@movies/contracts/diagnostics";
import type { PlaybackTokenInvalid } from "@movies/contracts/playback-token";
import { Clock, Context, Effect, Layer, Option } from "effect";

import { makeLimiter } from "../http/rate-limit.ts";
import type { PlaybackGrant } from "../playback/playback-token.ts";
import * as PlaybackToken from "../playback/playback-token.ts";
import * as StreamOwners from "../playback/stream-owners.ts";
import { grantAnnotations, LogEvent, SLOW_MS } from "./log-events.ts";

/** Records players' events. */
export interface Interface {
  /**
   * Writes the batch to the log. Fails with `PlaybackTokenInvalid` for a bad token and
   * `DiagnosticsRateLimited` once the session or its account has sent more than its budget;
   * nothing is written then.
   */
  readonly record: (
    request: ClientDiagnosticsRequest,
  ) => Effect.Effect<void, PlaybackTokenInvalid | DiagnosticsRateLimited>;
}

/** The client event recorder. */
export class Service extends Context.Service<Service, Interface>()(
  "@movies/media/ClientDiagnostics",
) {}

/**
 * Events one playback session may send at once, and how many more each second after that. A
 * player sends a few per minute; a burst of errors fits, a flood does not.
 */
const SESSION_BUDGET = { burst: 300, perSecond: 2 };

/**
 * The same for all of one account's sessions together: a second session has some room of its own,
 * but opening more sessions does not multiply what an account may write.
 */
const USER_BUDGET = { burst: 400, perSecond: 2 };

const commonFields = (
  event: ClientDiagnosticEvent,
  grant: PlaybackGrant,
  platform: ClientDiagnosticsRequest["platform"],
  receivedAt: number,
  ownStream: boolean,
) => ({
  source: "player",
  platform,
  occurredAt: new Date(receivedAt - event.ageMs).toISOString(),
  ...grantAnnotations(grant),
  streamId: ownStream ? (event.streamId ?? null) : null,
  claimedStreamId: ownStream ? null : (event.streamId ?? null),
});

/** Logs one observation under its `Player.*` name with `fields` and its own. */
const logObservation = (observation: PlayerObservation, fields: ReturnType<typeof commonFields>) =>
  PlayerObservation.match(observation, {
    Attached: ({ mode, engine }) =>
      Effect.logInfo(LogEvent.playerAttached).pipe(
        Effect.annotateLogs({ ...fields, mode, engine }),
      ),
    BufferingStarted: ({ positionSeconds, bufferedAheadSeconds }) =>
      Effect.logInfo(LogEvent.bufferingStarted).pipe(
        Effect.annotateLogs({ ...fields, positionSeconds, bufferedAheadSeconds }),
      ),
    BufferingEnded: ({ positionSeconds, bufferedAheadSeconds, durationMs, endedBy }) =>
      (durationMs >= SLOW_MS
        ? Effect.logWarning(LogEvent.bufferingEnded)
        : Effect.logInfo(LogEvent.bufferingEnded)
      ).pipe(
        Effect.annotateLogs({
          ...fields,
          positionSeconds,
          bufferedAheadSeconds,
          stalledMs: durationMs,
          endedBy,
        }),
      ),
    PlayerError: ({ source, kind, detail, fatal, status }) =>
      (fatal
        ? Effect.logError(LogEvent.playerError)
        : Effect.logWarning(LogEvent.playerError)
      ).pipe(
        Effect.annotateLogs({
          ...fields,
          errorSource: source,
          kind,
          detail,
          fatal,
          status: status ?? null,
        }),
      ),
    DroppedFrames: ({ dropped, decoded }) =>
      Effect.logInfo(LogEvent.droppedFrames).pipe(
        Effect.annotateLogs({ ...fields, dropped, decoded }),
      ),
    FragmentLoaded: ({ segment, durationMs, firstByteMs, bytes }) =>
      (durationMs >= SLOW_MS
        ? Effect.logWarning(LogEvent.fragmentLoaded)
        : Effect.logDebug(LogEvent.fragmentLoaded)
      ).pipe(
        Effect.annotateLogs({ ...fields, segment, elapsedMs: durationMs, firstByteMs, bytes }),
      ),
    Recovery: ({ action, reason }) =>
      Effect.logWarning(LogEvent.recovery).pipe(Effect.annotateLogs({ ...fields, action, reason })),
  });

const make = Effect.gen(function* () {
  const verifier = yield* PlaybackToken.Service;
  const owners = yield* StreamOwners.Service;
  const take = makeLimiter();

  const record = Effect.fn("ClientDiagnostics.record")(function* (
    request: ClientDiagnosticsRequest,
  ) {
    const grant = yield* verifier.verifyReport(request.token);
    const receivedAt = yield* Clock.currentTimeMillis;
    const cost = request.events.length;

    const wait = Option.orElse(
      take(`session\u0000${grant.sessionId}`, SESSION_BUDGET, receivedAt, cost),
      () => take(`user\u0000${grant.userId}`, USER_BUDGET, receivedAt, cost),
    );

    if (Option.isSome(wait)) {
      return yield* new DiagnosticsRateLimited({ retryAfterSeconds: wait.value });
    }

    return yield* Effect.forEach(
      request.events,
      (event) =>
        Effect.flatMap(
          event.streamId === undefined
            ? Effect.succeed(true)
            : owners.belongsTo(event.streamId, grant.sessionId),
          (ownStream) =>
            logObservation(
              event.observation,
              commonFields(event, grant, request.platform, receivedAt, ownStream),
            ),
        ),
      { discard: true },
    );
  });

  return Service.of({ record });
});

/** The recorder over the configured verifier. */
export const layer: Layer.Layer<Service, never, PlaybackToken.Service | StreamOwners.Service> =
  Layer.effect(Service, make);
