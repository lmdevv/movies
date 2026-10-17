/**
 * The room engine: keeps one device's player on a watch room's shared timeline.
 *
 * - **Clock offset.** Reads the server clock several times at start and again periodically, and
 *   computes every target in server time from the best round trip.
 * - **Followers** (guests, and a host reverting) apply committed clocks in revision order and
 *   correct drift: a gentle rate nudge for small drift, a seek for large drift. A guest that
 *   stalls buffers locally and catches up when it plays again; a guest who pauses their own
 *   player is left alone until they play again. Guest player events never become room commands.
 * - **The host's** player is compared with the committed clock after each player event; a
 *   difference becomes `rooms.play`, `pause`, `seek`, or `buffering` at the revision the host last
 *   saw. A stall freezes the room, and recovery publishes a fresh playing anchor. Only a command
 *   rejected as stale, or a reconnect, moves the host's player onto the committed clock, apart
 *   from a host starting far from a playing room's live position, which catches up with it first.
 * - **Next episode.** The room's countdown is part of its record (`room.next`), due at a server
 *   time; `nextEpisodeCountdownMs` reads it with this device's clock offset. The server moves the
 *   room on, and each player opens the new media itself.
 * - **Presence.** Heartbeats every few seconds; the host's carry its position so the server can
 *   re-anchor drift, and a following guest's carry its measured drift so the room can show it. An unanswered heartbeat marks the connection lost and disables host controls
 *   until the room has been read again.
 *
 * Host commands, heartbeats, and corrections run one at a time, so every command carries the
 * newest revision this device has applied.
 */
import type { ClockOffset, ClockSample } from "@movies/contracts/clock";
import type { CommandArgs } from "@movies/contracts/commands";
import {
  countdownRemaining,
  estimateClockOffset,
  isNewerRevision,
  targetPosition,
  toServerTime,
} from "@movies/contracts/clock";
import type { DeviceId, RoomId } from "@movies/contracts/ids";
import type { Room, RoomClock } from "@movies/contracts/models/rooms";
import type { EpochMillis } from "@movies/contracts/units";
import { EpochMillis as EpochMillisSchema, Milliseconds } from "@movies/contracts/units";
import {
  Clock,
  Duration,
  Effect,
  Option,
  Predicate,
  Ref,
  Schedule,
  Schema,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect";

import { MoviesClient } from "../movies-client";
import type { CallError } from "../sdk-errors";
import type { PlayerEvent, PlayerPort } from "./player-port";
import { playerEvents } from "./player-port";
import { readServerClock } from "./server-clock";
import type { HostCommand, PlayerSnapshot, RoomSyncTunables } from "./sync-policy";
import { commandLabel, follow, hostIntent, PlayerCommand } from "./sync-policy";

/** This device's part in the room. */
export type RoomRole = "host" | "guest";

/**
 * How this device follows the room. `buffering`: stalled, catching up when it plays again.
 * `detached`: the guest paused their own player; following resumes when they play. `blocked`:
 * the platform refused to start playback until the user interacts. `ended`: the room is over.
 */
export type FollowState = "following" | "buffering" | "detached" | "blocked" | "ended";

/** Where the engine stands, for the UI. */
export interface RoomSyncState {
  readonly role: RoomRole;
  /** The newest room snapshot: members, title, and presence. */
  readonly room: Room;
  /** The newest committed clock applied; it can be newer than `room.clock`. */
  readonly clock: RoomClock;
  /** `reconnecting` after a heartbeat went unanswered, until the room has been read again. */
  readonly connection: "connected" | "reconnecting";
  readonly follow: FollowState;
  /** Server time minus device time, once estimated. */
  readonly offset: ClockOffset | null;
  /** The last measured distance from the shared position; positive means ahead. */
  readonly driftMs: number | null;
}

/** Whether a host may use its controls now: connected, synchronized, and the room still open. */
export const hostControlsEnabled = (state: RoomSyncState): boolean =>
  state.role === "host" &&
  state.connection === "connected" &&
  state.offset !== null &&
  state.clock.status !== "ended";

/**
 * How long is left on the room's next-episode countdown at `deviceNow`, by the server's clock as
 * this device estimates it (its own clock until the offset is known), or null while none runs.
 * Every member computes it from the same `nextAt`, so they all count down together, and a member
 * who reloads mid-countdown picks it up where the others are.
 */
export const nextEpisodeCountdownMs = (
  state: Pick<RoomSyncState, "room" | "offset">,
  deviceNow: number,
): Milliseconds | null => {
  const { next } = state.room;

  if (next?.status !== "pending") return null;

  const serverNow =
    state.offset === null
      ? EpochMillisSchema.make(deviceNow)
      : toServerTime(deviceNow, state.offset);

  return countdownRemaining(next.nextAt, serverNow);
};

/** What to synchronize. */
export interface RoomSyncOptions {
  readonly roomId: RoomId;
  /** This device; it is the host when it matches the room's host device. */
  readonly deviceId: DeviceId;
  readonly player: PlayerPort;
  readonly tunables: RoomSyncTunables;
}

/** A running engine. It stops when its scope closes. */
export interface RoomSync {
  /** The current state, then every change. */
  readonly state: Stream.Stream<RoomSyncState>;
  /** The state now. */
  readonly current: Effect.Effect<RoomSyncState>;
}

/** The platform refused to start playback, usually until the user interacts with the page. */
class PlaybackBlocked extends Schema.TaggedError<PlaybackBlocked>()("PlaybackBlocked", {
  cause: Schema.Defect(),
}) {}

/**
 * Starts synchronizing `options.player` with the room. Reads the room and the server clock first,
 * so a late joiner seeks straight to the live position; fails when the room cannot be read.
 */
export const run = Effect.fn("RoomSync.run")(function* (options: RoomSyncOptions) {
  const client = yield* MoviesClient;
  const { player, tunables, roomId, deviceId } = options;
  const initial = yield* client.query("rooms.get", { roomId });
  const role: RoomRole = initial.hostDeviceId === deviceId ? "host" : "guest";
  const window = Math.max(1, tunables.offsetSamples * 2);
  const samples = yield* Ref.make<ReadonlyArray<ClockSample>>([]);
  const lastSeekAt = yield* Ref.make(Option.none<number>());
  /**
   * The clock revision the follower last acted on, if any. Joining and every clock change give it a
   * fresh target, which `follow` settles onto from `settleMs`; keyed by revision, a clock applied
   * while a decision was made for an older one still counts as fresh.
   */
  const settledOn = yield* Ref.make<number | null>(null);
  const pauseEchoes = yield* Ref.make(0);
  /**
   * When a starting host began catching up with a playing room it was far from (`joinLiveClock`),
   * while it still is. Meanwhile the host follows the clock as a guest does and publishes nothing.
   */
  const catchingUpSince = yield* Ref.make(Option.none<number>());
  /**
   * Where the engine seeked the catching-up host's player, until a `seeked` lands there. A
   * `seeked` landing on one is the engine's; one landing elsewhere is the host's own, even when it
   * replaced an engine seek before that one finished.
   */
  const catchUpSeeks = yield* Ref.make<ReadonlyArray<number>>([]);
  /** Whether the catch-up nudged the player's rate, which ending it then puts back. */
  const catchUpNudged = yield* Ref.make(false);
  const serial = yield* Semaphore.make(1);

  const state = yield* SubscriptionRef.make<RoomSyncState>({
    role,
    room: initial,
    clock: initial.clock,
    connection: "connected",
    follow: initial.clock.status === "ended" ? "ended" : "following",
    offset: null,
    driftMs: null,
  });

  const update = (f: (current: RoomSyncState) => RoomSyncState): Effect.Effect<void> =>
    SubscriptionRef.update(state, f);

  const addSamples = Effect.fn("RoomSync.addSamples")(function* () {
    const fresh = yield* readServerClock(tunables.offsetSamples, tunables.offsetSampleSpacingMs);
    const kept = yield* Ref.updateAndGet(samples, (old) => [...old, ...fresh].slice(-window));
    const offset = estimateClockOffset(kept) ?? null;

    yield* update((current) => ({ ...current, offset }));
  });

  const serverNow: Effect.Effect<Option.Option<EpochMillis>> = Effect.gen(function* () {
    const { offset } = yield* SubscriptionRef.get(state);

    if (offset === null) return Option.none();
    const now = yield* Clock.currentTimeMillis;

    return Option.some(toServerTime(now, offset));
  });

  const snapshot = (): PlayerSnapshot => ({
    positionMs: player.positionMs(),
    paused: player.isPaused(),
    buffering: player.isBuffering(),
    playbackRate: player.playbackRate(),
    fixedRate: player.fixedRate === true,
  });

  const execute = (command: PlayerCommand): Effect.Effect<void> =>
    PlayerCommand.$match(command, {
      Seek: ({ positionMs }) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;

          if (Option.isSome(yield* Ref.get(catchingUpSince))) {
            yield* Ref.update(catchUpSeeks, (targets) => [...targets, positionMs]);
          }

          yield* Ref.set(lastSeekAt, Option.some(now));
          player.seek(positionMs);
        }),
      Pause: () =>
        Effect.gen(function* () {
          yield* Ref.update(pauseEchoes, (count) => count + 1);
          player.pause();
        }),
      SetRate: ({ rate }) =>
        Effect.gen(function* () {
          if (Option.isSome(yield* Ref.get(catchingUpSince))) yield* Ref.set(catchUpNudged, true);
          player.setPlaybackRate(rate);
        }),
      Play: () =>
        Effect.tryPromise({
          try: () => player.play(),
          catch: (cause) => new PlaybackBlocked({ cause }),
        }).pipe(
          Effect.catchTag("PlaybackBlocked", () =>
            Effect.gen(function* () {
              yield* Effect.logInfo("RoomSync.playBlocked");
              yield* update((current) => ({ ...current, follow: "blocked" }));
            }),
          ),
        ),
    });

  /** Moves the player toward the committed clock. Callers hold `serial`. */
  const align = Effect.fn("RoomSync.align")(function* () {
    const current = yield* SubscriptionRef.get(state);
    const now = yield* serverNow;

    if (Option.isNone(now)) return;
    const clientNow = yield* Clock.currentTimeMillis;

    const recentlySought = Option.match(yield* Ref.get(lastSeekAt), {
      onNone: () => false,
      onSome: (at) => clientNow - at < tunables.seekCooldownMs,
    });

    const decision = follow(
      current.clock,
      now.value,
      snapshot(),
      recentlySought,
      (yield* Ref.get(settledOn)) !== current.clock.revision,
      tunables,
    );

    yield* Ref.set(settledOn, decision.settling ? null : current.clock.revision);
    yield* update((latest) => ({ ...latest, driftMs: decision.driftMs }));

    if (decision.commands.length > 0) {
      yield* Effect.logDebug("RoomSync.correct").pipe(
        Effect.annotateLogs({
          roomId,
          revision: current.clock.revision,
          driftMs: decision.driftMs ?? "buffering",
          commands: decision.commands.map(commandLabel).join(","),
        }),
      );
    }

    yield* Effect.forEach(decision.commands, execute, { discard: true });
  });

  /** Ends the host's catch-up, putting back the room's rate if a nudge changed it. */
  const endCatchUp = Effect.gen(function* () {
    yield* Ref.set(catchingUpSince, Option.none<number>());
    yield* Ref.set(catchUpSeeks, []);
    const { clock } = yield* SubscriptionRef.get(state);

    if (yield* Ref.getAndSet(catchUpNudged, false)) player.setPlaybackRate(clock.playbackRate);
  });

  /** Whether the host is catching up, for no longer than `hostCatchUpMs`. */
  const isCatchingUp: Effect.Effect<boolean> = Effect.gen(function* () {
    const since = yield* Ref.get(catchingUpSince);

    if (Option.isNone(since)) return false;

    return (yield* Clock.currentTimeMillis) - since.value < tunables.hostCatchUpMs;
  });

  /**
   * Clears a catch-up whose time ran out but that no correction has ended yet, putting the rate
   * back before the host publishes or reports its position again. Callers hold `serial`.
   */
  const settleExpiredCatchUp = Effect.gen(function* () {
    if (Option.isSome(yield* Ref.get(catchingUpSince))) yield* endCatchUp;
  });

  /**
   * A catching-up host's correction. It ends once the host is in step with a playing clock, the
   * platform refuses to play, or `hostCatchUpMs` passes; the host then publishes its player's
   * state, which the catch-up held back. A clock that stopped playing (the server paused the room)
   * ends it too, and the player follows that clock rather than undo it. Callers hold `serial`.
   */
  const catchUp = Effect.fn("RoomSync.catchUp")(function* (current: RoomSyncState) {
    if (Option.isNone(yield* Ref.get(catchingUpSince))) return;

    if (current.clock.status !== "playing") {
      yield* endCatchUp;
      yield* align();

      return;
    }

    if (!(yield* isCatchingUp)) {
      yield* endCatchUp;
      yield* publishNow(false);

      return;
    }

    yield* align();
    const { driftMs, follow: following } = yield* SubscriptionRef.get(state);
    const settled = (yield* Ref.get(settledOn)) === current.clock.revision;

    // A player the platform will not start without a gesture cannot catch up: the room pauses
    // with it, as for any host whose player is paused, until the host plays.
    if (following === "blocked") {
      yield* update((latest) => ({ ...latest, follow: "following" }));
      yield* endCatchUp;
      yield* publishNow(false);

      return;
    }

    if (settled && driftMs !== null && Math.abs(driftMs) <= tunables.inSyncMs) {
      yield* endCatchUp;
      yield* publishNow(false);
    }
  });

  /**
   * A guest's drift correction, skipped while it is detached, blocked, or the room is over; for
   * the host, its catch-up.
   */
  const correct = serial.withPermits(1)(
    Effect.gen(function* () {
      const current = yield* SubscriptionRef.get(state);

      // Before the ended check: a host's catch-up ends with the room too.
      if (current.role === "host") {
        yield* catchUp(current);

        return;
      }

      if (current.follow === "ended") return;

      const following = current.follow === "following" || current.follow === "buffering";

      if (!following && current.clock.status === "playing") return;

      yield* align();
    }),
  );

  /** Applies `clock` when it is newer than the applied one. Reports whether it was. */
  const applyClock = (clock: RoomClock): Effect.Effect<boolean> =>
    SubscriptionRef.modify(state, (current) => {
      if (!isNewerRevision(clock, current.clock)) return [false, current];

      const followState: FollowState =
        clock.status === "ended"
          ? "ended"
          : current.follow === "detached" && clock.status !== "playing"
            ? "following"
            : current.follow;

      return [true, { ...current, clock, follow: followState }];
    });

  /** Reads the committed room and moves the player onto it. */
  const resync = serial.withPermits(1)(
    Effect.gen(function* () {
      const room = yield* client.query("rooms.get", { roomId });

      yield* update((current) => ({ ...current, room }));
      yield* applyClock(room.clock);
      yield* align();
    }),
  );

  const markReconnecting = update((current) => ({ ...current, connection: "reconnecting" }));

  const sendHostCommand = Effect.fn("RoomSync.hostCommand")(function* (
    intent: HostCommand,
    revision: number,
  ) {
    const result = yield* client.mutate(intent.command, {
      roomId,
      deviceId,
      revision,
      positionMs: intent.positionMs,
    });

    yield* applyClock(result);
  });

  /**
   * Publishes the host player's state as a room command when it differs from the clock. Callers
   * hold `serial`; `publish` takes it.
   */
  function publishNow(seeked: boolean): Effect.Effect<void> {
    return Effect.gen(function* () {
      const current = yield* SubscriptionRef.get(state);

      if (current.role !== "host" || current.connection !== "connected") return;

      if (yield* isCatchingUp) return;
      yield* settleExpiredCatchUp;
      const now = yield* serverNow;

      if (Option.isNone(now)) return;
      const intent = hostIntent(current.clock, now.value, snapshot(), seeked, tunables);

      if (Option.isNone(intent)) return;

      yield* sendHostCommand(intent.value, current.clock.revision).pipe(
        Effect.catchTag("TransportError", () => markReconnecting),
        Effect.catch((error: CallError) =>
          Effect.gen(function* () {
            // Stale revision, or the room moved on: revert to the committed clock.
            yield* Effect.logInfo("RoomSync.hostCommandRejected", error).pipe(
              Effect.annotateLogs({ roomId, command: intent.value.command }),
            );

            const room = yield* client.query("rooms.get", { roomId });

            yield* update((latest) => ({ ...latest, room }));
            yield* applyClock(room.clock);
            yield* align();
          }).pipe(Effect.catch(() => markReconnecting)),
        ),
      );
    });
  }

  /** `publishNow`, holding `serial`. */
  const publish = (seeked: boolean): Effect.Effect<void> =>
    serial.withPermits(1)(publishNow(seeked));

  /**
   * Starts a host whose player is further than `hostSeekMs` from a playing room's live position
   * catching up with it. The host's stream starts wherever it was negotiated, seconds before frames
   * show; publishing from there, or reporting that position, would pull the room back for every
   * guest, and the stall a catch-up seek may cause would freeze it. So the host follows the clock
   * as a guest does, publishing nothing and reporting no position, until it is in step, it pauses
   * or seeks its own player, or `hostCatchUpMs` passes. A host coming back to the room, or reloading, joins
   * the time its guests are watching.
   */
  const joinLiveClock = serial.withPermits(1)(
    Effect.gen(function* () {
      const { clock } = yield* SubscriptionRef.get(state);
      const now = yield* serverNow;

      if (clock.status !== "playing") return;

      // Without a clock offset yet the distance is unknown: catch up once the offset arrives.
      if (
        Option.isSome(now) &&
        Math.abs(player.positionMs() - targetPosition(clock, now.value)) <= tunables.hostSeekMs
      ) {
        return;
      }

      yield* Ref.set(catchingUpSince, Option.some(yield* Clock.currentTimeMillis));
      yield* align();
    }),
  );

  const onPlayerEvent = (event: PlayerEvent): Effect.Effect<void> =>
    Effect.gen(function* () {
      const current = yield* SubscriptionRef.get(state);

      if (current.role === "host") {
        if (!(yield* isCatchingUp)) {
          yield* publish(event === "seeked");

          return;
        }

        if (event === "paused") {
          const echo = yield* Ref.modify(pauseEchoes, (count) =>
            count > 0 ? [true, count - 1] : [false, 0],
          );

          // The host paused their own player: the catch-up ends, and the room pauses with them.
          // Under `serial`, so no correction is midway through a nudge as it ends.
          if (!echo) yield* serial.withPermits(1)(Effect.andThen(endCatchUp, publishNow(false)));

          return;
        }

        if (event === "seeked") {
          const landed = player.positionMs();
          const now = yield* serverNow;

          // The engine seeks to the live position, so its seek lands on it, or on the target as
          // the clock stood then; this event may be handled a while after it landed. Without a
          // clock offset there is no telling, and nothing could be published anyway.
          const onClock = Option.match(now, {
            onNone: () => true,
            onSome: (at) => Math.abs(landed - targetPosition(current.clock, at)) <= tunables.seekMs,
          });

          const echo = yield* Ref.modify(catchUpSeeks, (targets) => {
            const at = targets.findIndex(
              // A stream may land a little off its target, on a keyframe.
              (target) => Math.abs(landed - target) <= tunables.seekMs,
            );

            // Earlier targets were replaced by this one, or already landed.
            if (at !== -1) return [true, targets.slice(at + 1)];

            // Landing on the room's time is no change of the host's, whoever seeked.
            return [onClock, onClock ? targets.slice(1) : targets];
          });

          // The host seeked their own player: the catch-up ends, and the room seeks with them.
          if (!echo) {
            yield* serial.withPermits(1)(Effect.andThen(endCatchUp, publishNow(true)));

            return;
          }
        }

        if (event === "playing" || event === "seeked") yield* correct;

        return;
      }

      if (event === "waiting") {
        if (current.follow === "following") {
          yield* update((latest) => ({ ...latest, follow: "buffering" }));
        }

        return;
      }

      if (event === "paused") {
        const echo = yield* Ref.modify(pauseEchoes, (count) =>
          count > 0 ? [true, count - 1] : [false, 0],
        );

        if (!echo && current.clock.status === "playing" && current.follow !== "ended") {
          yield* update((latest) => ({ ...latest, follow: "detached" }));
        }

        return;
      }

      if (event === "playing" && current.follow !== "following" && current.follow !== "ended") {
        yield* update((latest) => ({ ...latest, follow: "following" }));
      }

      if (event === "playing" || event === "seeked") yield* correct;
    });

  /**
   * The host reports its position and when it read it, by the server clock as it estimates it,
   * except while it catches up; a following guest reports its drift.
   */
  const heartbeatArgs = (
    current: RoomSyncState,
    now: Option.Option<EpochMillis>,
    catching: boolean,
  ): CommandArgs<"rooms.heartbeat"> => {
    if (current.role === "host" && catching) return { roomId, deviceId };

    if (current.role === "host") {
      return {
        roomId,
        deviceId,
        positionMs: Milliseconds.make(Math.max(0, player.positionMs())),
        ...Option.match(now, { onNone: () => ({}), onSome: (atServerTime) => ({ atServerTime }) }),
        revision: current.clock.revision,
      };
    }

    if (current.follow === "following" && current.driftMs !== null) {
      return { roomId, deviceId, driftMs: current.driftMs };
    }

    return { roomId, deviceId };
  };

  /**
   * Sends one heartbeat, reading the state only once it holds `serial`: a host command that held
   * it may have moved the revision meanwhile. The answer is applied before the permit goes, so a
   * host command that waited for it never sends the revision a re-anchor just replaced.
   */
  const beat = serial.withPermits(1)(
    Effect.gen(function* () {
      const current = yield* SubscriptionRef.get(state);
      const now = yield* serverNow;
      const catching = yield* isCatchingUp;

      // A catch-up that ran out ends here first, publishing what it held back.
      if (!catching && Option.isSome(yield* Ref.get(catchingUpSince))) {
        yield* endCatchUp;
        yield* publishNow(false);
      }

      const clock = yield* client.mutate("rooms.heartbeat", heartbeatArgs(current, now, catching));

      return {
        newer: yield* applyClock(clock),
        wasReconnecting: current.connection === "reconnecting",
      };
    }),
  );

  const heartbeat = Effect.gen(function* () {
    const { clock } = yield* SubscriptionRef.get(state);

    if (clock.status === "ended") return;

    const answered = yield* beat.pipe(
      Effect.timeoutOption(Duration.millis(tunables.heartbeatTimeoutMs)),
      Effect.catchTag("TransportError", () => Effect.succeedNone),
    );

    if (Option.isNone(answered)) {
      yield* markReconnecting;

      return;
    }

    const { newer, wasReconnecting } = answered.value;

    yield* update((latest) => ({ ...latest, connection: "connected" }));

    if (wasReconnecting) {
      yield* resync.pipe(Effect.catch(() => markReconnecting));

      return;
    }

    if (newer) yield* correct;
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("RoomSync.heartbeatRejected", error).pipe(Effect.annotateLogs({ roomId })),
    ),
  );

  const subscription = client.subscribe("rooms.get", { roomId }).pipe(
    Stream.runForEach((room) =>
      Effect.gen(function* () {
        yield* update((current) => ({ ...current, room }));
        const newer = yield* applyClock(room.clock);

        // The host reverts only on a rejected command or a reconnect: its own commands reach the
        // subscription before their results do, and aligning to them would echo them back.
        if (newer) yield* correct;
      }),
    ),
    Effect.tapError(() => markReconnecting),
    Effect.retry({
      while: (error) =>
        !Predicate.isTagged(error, "NotFound") && !Predicate.isTagged(error, "Forbidden"),
      schedule: Schedule.spaced(Duration.millis(tunables.resubscribeDelayMs)),
    }),
    Effect.catch((error) =>
      Effect.logWarning("RoomSync.subscriptionEnded", error).pipe(Effect.annotateLogs({ roomId })),
    ),
  );

  const events = yield* playerEvents(player);

  yield* addSamples();

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const { clock } = yield* SubscriptionRef.get(state);

      player.setPlaybackRate(clock.playbackRate);
    }),
  );

  // Before the heartbeat and the player's events run, so neither reports the stream's start.
  if (role === "host") yield* joinLiveClock;

  yield* Effect.forkScoped(Stream.runForEach(events, onPlayerEvent));
  yield* Effect.forkScoped(subscription);
  yield* Effect.forkScoped(
    heartbeat.pipe(Effect.repeat(Schedule.spaced(Duration.millis(tunables.heartbeatIntervalMs)))),
  );
  yield* Effect.forkScoped(
    addSamples().pipe(
      Effect.delay(Duration.millis(tunables.offsetRefreshIntervalMs)),
      Effect.forever,
    ),
  );

  const correcting = Schedule.spaced(Duration.millis(tunables.correctionIntervalMs));

  if (role === "guest") {
    yield* Effect.forkScoped(correct.pipe(Effect.repeat(correcting)));
  } else {
    // The host corrects only while it catches up.
    yield* Effect.forkScoped(
      correct.pipe(
        Effect.andThen(Effect.map(Ref.get(catchingUpSince), Option.isSome)),
        Effect.repeat({ schedule: correcting, while: (catching) => catching }),
      ),
    );
    yield* publish(false);
  }

  const handle: RoomSync = {
    state: SubscriptionRef.changes(state),
    current: SubscriptionRef.get(state),
  };

  return handle;
});
