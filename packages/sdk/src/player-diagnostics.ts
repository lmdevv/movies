/**
 * What a player saw while it played, sent to the media service for its retained log, where
 * `movies diagnostics playback` reads it: stalls (from the player's `waiting` and `playing`
 * events), dropped frames (sampled where the platform counts them), and whatever the platform
 * records itself, such as hls.js segment loads, decoder errors, and recoveries.
 *
 * Events are batched and sent every few seconds with the playback token, never with the session's
 * Convex token, and the last batch is sent as the scope closes. Sending is best effort: a batch
 * the service refuses or cannot take is dropped, and playback never waits on it.
 */
import {
  type ClientDiagnosticEvent,
  ClientDiagnosticsRequest,
  type ClientPlatform,
  DIAGNOSTICS_ROUTES,
  MAX_CLIENT_EVENTS,
  PlayerObservation,
} from "@movies/contracts/diagnostics";
import {
  Array as Arr,
  Clock,
  Duration,
  Effect,
  Option,
  Queue,
  Redacted,
  Ref,
  Schedule,
  Schema,
  Semaphore,
} from "effect";
import type { Scope } from "effect";

import { encodeJson, mediaUrl, requestPlayback } from "./media-http";
import type { Playback } from "./playback";
import type { PlayerEvent, PlayerPort } from "./room-sync/player-port";

/** Records what a player saw. */
export interface Recorder {
  /**
   * Notes `observation` as happening now, in the stream playing now; it goes out with the next
   * batch. Never blocks or fails.
   */
  readonly record: (observation: PlayerObservation) => void;
}

/** Frames the decoder has dropped and decoded since the element or player was created. */
export interface FrameCounts {
  readonly dropped: number;
  readonly decoded: number;
}

/** Where the recorder sends events and what it samples on its own. */
export interface Options {
  readonly platform: ClientPlatform;
  /**
   * The playback playing now, if one does. An event goes out with the token of the playback that
   * played when it happened, which stays good for its session's last events once it ended.
   */
  readonly playback: () => Option.Option<Playback>;
  /** Seconds the player holds ahead of its position. */
  readonly bufferedAheadSeconds: () => number;
  /** The decoder's frame counts, where the platform reports them. */
  readonly frames: () => Option.Option<FrameCounts>;
}

/** How often events are sent. */
const FLUSH_INTERVAL = Duration.seconds(5);

/** How long the last batch may take as the scope closes. */
const FINAL_FLUSH_TIMEOUT = Duration.seconds(2);

/** Events kept while none can be sent; beyond this the oldest go. */
const MAX_PENDING = 500;

/** The service refuses events older than this. */
const MAX_AGE_MS = 600_000;

/** An observation waiting to be sent: what happened, when, and during which playback. */
interface Pending {
  readonly observation: PlayerObservation;
  readonly at: number;
  readonly playback: Playback;
}

/** `pending` as the events of a batch sent at `now`, leaving out those too old to send. */
const toEvents = (
  pending: ReadonlyArray<Pending>,
  now: number,
): ReadonlyArray<ClientDiagnosticEvent> =>
  pending.flatMap(({ observation, at, playback }): ReadonlyArray<ClientDiagnosticEvent> => {
    const ageMs = Math.max(0, Math.round(now - at));

    if (ageMs > MAX_AGE_MS) return [];

    return [
      Option.match(Option.fromNullishOr(playback.stream.streamId), {
        onNone: () => ({ ageMs, observation }),
        onSome: (id) => ({ ageMs, streamId: id, observation }),
      }),
    ];
  });

const batches = <A>(events: ReadonlyArray<A>): ReadonlyArray<ReadonlyArray<A>> =>
  Array.from({ length: Math.ceil(events.length / MAX_CLIENT_EVENTS) }, (_, index) =>
    events.slice(index * MAX_CLIENT_EVENTS, (index + 1) * MAX_CLIENT_EVENTS),
  );

/** Sends `events` for `playback`'s session; a refused or lost batch is logged and dropped. */
const send = (
  playback: Playback,
  platform: ClientPlatform,
  events: ReadonlyArray<ClientDiagnosticEvent>,
): Effect.Effect<void> =>
  Effect.forEach(
    batches(events),
    (batch) =>
      encodeJson(ClientDiagnosticsRequest, {
        token: Redacted.make(playback.started.token),
        platform,
        events: batch,
      }).pipe(
        Effect.flatMap((body) =>
          requestPlayback(
            {
              operation: "playback.diagnostics",
              url: mediaUrl(playback.started, DIAGNOSTICS_ROUTES.clientEvents),
              method: "POST",
              body: Option.some(body),
              bearer: Option.none(),
            },
            Schema.Null,
          ),
        ),
        Effect.catch((error) => Effect.logDebug("PlayerDiagnostics.dropped", error)),
      ),
    { discard: true },
  );

/**
 * Records `player`'s stalls and the platform's own events until the scope closes, sending them
 * in batches with the playback `options.playback` names.
 */
export const reportDiagnostics = Effect.fn("PlayerDiagnostics.report")(function* (
  player: PlayerPort,
  options: Options,
): Effect.fn.Return<Recorder, never, Scope.Scope> {
  const clock = yield* Clock.Clock;
  const queue = yield* Queue.sliding<Pending>(MAX_PENDING);
  const counted = yield* Ref.make<FrameCounts>({ dropped: 0, decoded: 0 });
  const oneBatchAtATime = yield* Semaphore.make(1);
  /** When the current stall began; none while playing. Player events change it as they fire. */
  const stall = { since: Option.none<number>() };

  /** Keeps `observation` for the next batch; with no playback playing there is no one to tell. */
  const note = (observation: PlayerObservation): void => {
    const playback = options.playback();

    if (Option.isSome(playback)) {
      Queue.offerUnsafe(queue, {
        observation,
        at: clock.currentTimeMillisUnsafe(),
        playback: playback.value,
      });
    }
  };

  const where = () => ({
    positionSeconds: Math.max(0, player.positionMs() / 1000),
    bufferedAheadSeconds: Math.max(0, options.bufferedAheadSeconds()),
  });

  const onPlayerEvent = (event: PlayerEvent): void => {
    const now = clock.currentTimeMillisUnsafe();

    if (event === "waiting" && Option.isNone(stall.since)) {
      stall.since = Option.some(now);
      note(PlayerObservation.cases.BufferingStarted.make(where()));

      return;
    }

    if ((event === "playing" || event === "paused") && Option.isSome(stall.since)) {
      const durationMs = Math.round(now - stall.since.value);

      stall.since = Option.none();
      note(PlayerObservation.cases.BufferingEnded.make({ ...where(), durationMs, endedBy: event }));
    }
  };

  const sampleFrames = Effect.gen(function* () {
    const counts = options.frames();

    if (Option.isNone(counts)) return;
    const previous = yield* Ref.getAndSet(counted, counts.value);
    const dropped = counts.value.dropped - previous.dropped;
    const decoded = counts.value.decoded - previous.decoded;

    // A new element counts from zero again, which reads as fewer frames and is skipped.
    if (dropped > 0 && decoded >= 0)
      note(PlayerObservation.cases.DroppedFrames.make({ dropped, decoded }));
  });

  const flush = oneBatchAtATime.withPermits(1)(
    Effect.gen(function* () {
      yield* sampleFrames;
      const pending = yield* Queue.clear(queue);
      const now = yield* Clock.currentTimeMillis;
      const byToken = Arr.groupBy(pending, (each) => each.playback.started.token);

      yield* Effect.forEach(
        Object.values(byToken),
        (group) => send(group[0].playback, options.platform, toEvents(group, now)),
        { discard: true },
      );
    }),
  );

  yield* Effect.acquireRelease(
    Effect.sync(() => player.subscribe(onPlayerEvent)),
    (unsubscribe) => Effect.sync(unsubscribe),
  );
  yield* Effect.forkScoped(Effect.repeat(Effect.delay(flush, FLUSH_INTERVAL), Schedule.forever));
  yield* Effect.addFinalizer(() => flush.pipe(Effect.timeout(FINAL_FLUSH_TIMEOUT), Effect.ignore));

  return { record: note } satisfies Recorder;
});
