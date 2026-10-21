/**
 * What a player saw while it played, sent to the media service for its retained log, where
 * `movies diagnostics playback` reads it: how long each playback session took to start and its
 * stalls after that (from the player's `waiting` and `playing` events), dropped frames (sampled
 * where the platform counts them), and whatever the platform records itself, such as hls.js
 * segment loads, decoder errors, and recoveries.
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
  type RecoveryAction,
} from "@movies/contracts/diagnostics";
import type { PlaybackSessionId } from "@movies/contracts/ids";
import {
  Array as Arr,
  Clock,
  Duration,
  Effect,
  Option,
  Queue,
  Redacted,
  Schedule,
  Schema,
  Semaphore,
} from "effect";
import type { Scope } from "effect";

import { encodeJson, mediaUrl, requestPlayback } from "./media-http";
import type { Playback } from "./playback";
import type { PlayerEvent, PlayerPort } from "./room-sync/player-port";

/** The longest recovery reason the service takes. */
const MAX_REASON_LENGTH = 120;

/** A recovery the player took after a failure `reason` describes, cut to what the service takes. */
export const recovery = (action: RecoveryAction, reason: string): PlayerObservation =>
  PlayerObservation.cases.Recovery.make({ action, reason: reason.slice(0, MAX_REASON_LENGTH) });

/** Records what a player saw. */
export interface Recorder {
  /**
   * Notes `observation` as happening now, in the stream playing now; it goes out with the next
   * batch. Never blocks or fails.
   */
  readonly record: (observation: PlayerObservation) => void;
  /**
   * Ends a startup or stall in progress as `closed` and samples dropped frames one last time,
   * reading the player now, so a caller can release the player right after. The player is never
   * read again; closing the scope sends what is queued. Closing twice does nothing more.
   */
  readonly close: () => void;
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
   * played when it happened, or else the last one that played: a token stays good for its
   * session's last events once the session ended.
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

/**
 * A wait for data while the viewer wants playback: the playback session's startup, before it first
 * played, or a stall after that.
 */
interface Wait {
  readonly kind: "startup" | "stall";
  readonly since: number;
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
          Effect.flatMap(mediaUrl(playback.started, DIAGNOSTICS_ROUTES.clientEvents), (url) =>
            requestPlayback(
              {
                operation: "playback.diagnostics",
                url,
                method: "POST",
                body: Option.some(body),
                bearer: Option.none(),
              },
              Schema.Null,
            ),
          ),
        ),
        Effect.catch((error) => Effect.logDebug("PlayerDiagnostics.dropped", error)),
      ),
    { discard: true },
  );

/**
 * Records how long each of `player`'s playback sessions takes to start, its stalls after that, and
 * the platform's own events until the scope closes, sending them in batches with the playback
 * `options.playback` names.
 */
export const reportDiagnostics = Effect.fn("PlayerDiagnostics.report")(function* (
  player: PlayerPort,
  options: Options,
): Effect.fn.Return<Recorder, never, Scope.Scope> {
  const clock = yield* Clock.Clock;
  const queue = yield* Queue.sliding<Pending>(MAX_PENDING);
  const oneBatchAtATime = yield* Semaphore.make(1);

  /**
   * The wait in progress, none while playing; the playback that played last; the playback session
   * that reached `playing`, after which its waits are stalls; the frame counts sampled last; and
   * whether the recorder closed, after which it reads nothing from the player. Player events and
   * records change them as they happen.
   */
  const state = {
    waiting: Option.none<Wait>(),
    lastPlayback: Option.none<Playback>(),
    played: Option.none<PlaybackSessionId>(),
    counted: { dropped: 0, decoded: 0 } satisfies FrameCounts,
    closed: false,
  };

  const playbackNow = (): Option.Option<Playback> =>
    Option.orElse(options.playback(), () => state.lastPlayback);

  /** Keeps `observation` for the next batch; before any playback there is no one to tell. */
  const note = (observation: PlayerObservation): void => {
    const playback = playbackNow();

    if (Option.isNone(playback)) return;
    state.lastPlayback = playback;
    Queue.offerUnsafe(queue, {
      observation,
      at: clock.currentTimeMillisUnsafe(),
      playback: playback.value,
    });
  };

  const positionSeconds = () => Math.max(0, player.positionMs() / 1000);

  const where = () => ({
    positionSeconds: positionSeconds(),
    bufferedAheadSeconds: Math.max(0, options.bufferedAheadSeconds()),
  });

  const startWait = (): void => {
    const session = Option.map(playbackNow(), (playback) => playback.started.sessionId);

    const kind = Option.exists(session, (id) => Option.contains(state.played, id))
      ? "stall"
      : "startup";

    state.waiting = Option.some({ kind, since: clock.currentTimeMillisUnsafe() });

    if (kind === "stall") note(PlayerObservation.cases.BufferingStarted.make(where()));
  };

  /** Ends the wait in progress, if there is one, as `endedBy` says. */
  const endWait = (endedBy: "playing" | "paused" | "closed"): void => {
    if (Option.isNone(state.waiting)) return;
    const { kind, since } = state.waiting.value;
    const durationMs = Math.round(clock.currentTimeMillisUnsafe() - since);

    state.waiting = Option.none();
    note(
      kind === "stall"
        ? PlayerObservation.cases.BufferingEnded.make({ ...where(), durationMs, endedBy })
        : PlayerObservation.cases.StartupEnded.make({
            positionSeconds: positionSeconds(),
            durationMs,
            endedBy,
          }),
    );
  };

  const onPlayerEvent = (event: PlayerEvent): void => {
    if (state.closed) return;

    if (event === "waiting" && Option.isNone(state.waiting) && !player.isPaused()) {
      startWait();
    } else if (event === "playing") {
      endWait(event);
      state.played = Option.map(playbackNow(), (playback) => playback.started.sessionId);
    } else if (event === "paused") {
      endWait(event);
    }
  };

  const sampleFrames = (): void => {
    if (state.closed) return;
    const counts = options.frames();

    if (Option.isNone(counts)) return;
    const dropped = counts.value.dropped - state.counted.dropped;
    const decoded = counts.value.decoded - state.counted.decoded;

    state.counted = counts.value;

    // A new element counts from zero again, which reads as fewer frames and is skipped.
    if (dropped > 0 && decoded >= 0)
      note(PlayerObservation.cases.DroppedFrames.make({ dropped, decoded }));
  };

  const close = (): void => {
    if (state.closed) return;
    endWait("closed");
    sampleFrames();
    state.closed = true;
  };

  const flush = oneBatchAtATime.withPermits(1)(
    Effect.gen(function* () {
      yield* Effect.sync(sampleFrames);
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
  yield* Effect.addFinalizer(() =>
    Effect.sync(close).pipe(
      Effect.andThen(flush),
      Effect.timeout(FINAL_FLUSH_TIMEOUT),
      Effect.ignore,
    ),
  );

  return { record: note, close } satisfies Recorder;
});
