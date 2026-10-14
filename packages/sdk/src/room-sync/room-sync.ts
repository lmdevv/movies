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
 *   rejected as stale, or a reconnect, moves the host's player onto the committed clock.
 * - **Presence.** Heartbeats every few seconds; the host's carry its position so the server can
 *   re-anchor drift, and a following guest's carry its measured drift so the room can show it. An unanswered heartbeat marks the connection lost and disables host controls
 *   until the room has been read again.
 *
 * Host commands, heartbeats, and corrections run one at a time, so every command carries the
 * newest revision this device has applied.
 */
import type { ClockOffset, ClockSample } from "@movies/contracts/clock";
import type { CommandArgs } from "@movies/contracts/commands";
import { estimateClockOffset, isNewerRevision, toServerTime } from "@movies/contracts/clock";
import type { DeviceId, RoomId } from "@movies/contracts/ids";
import type { Room, RoomClock } from "@movies/contracts/models/rooms";
import type { EpochMillis } from "@movies/contracts/units";
import { Milliseconds } from "@movies/contracts/units";
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
  const pauseEchoes = yield* Ref.make(0);
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

          yield* Ref.set(lastSeekAt, Option.some(now));
          player.seek(positionMs);
        }),
      Pause: () =>
        Effect.gen(function* () {
          yield* Ref.update(pauseEchoes, (count) => count + 1);
          player.pause();
        }),
      SetRate: ({ rate }) =>
        Effect.sync(() => {
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

    const decision = follow(current.clock, now.value, snapshot(), recentlySought, tunables);

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

  /** A guest's drift correction, skipped while it is detached, blocked, or the room is over. */
  const correct = serial.withPermits(1)(
    Effect.gen(function* () {
      const current = yield* SubscriptionRef.get(state);

      if (current.role !== "guest" || current.follow === "ended") return;

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

  /** Publishes the host player's state as a room command when it differs from the clock. */
  const publish = (seeked: boolean): Effect.Effect<void> =>
    serial.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* SubscriptionRef.get(state);

        if (current.role !== "host" || current.connection !== "connected") return;
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
      }),
    );

  const onPlayerEvent = (event: PlayerEvent): Effect.Effect<void> =>
    Effect.gen(function* () {
      const current = yield* SubscriptionRef.get(state);

      if (current.role === "host") {
        yield* publish(event === "seeked");

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

  /** The host reports its position; a following guest reports its drift. */
  const heartbeatArgs = (current: RoomSyncState): CommandArgs<"rooms.heartbeat"> => {
    if (current.role === "host") {
      return {
        roomId,
        deviceId,
        positionMs: Milliseconds.make(Math.max(0, player.positionMs())),
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
   * it may have moved the revision meanwhile.
   */
  const beat = serial.withPermits(1)(
    Effect.gen(function* () {
      const current = yield* SubscriptionRef.get(state);
      const clock = yield* client.mutate("rooms.heartbeat", heartbeatArgs(current));

      return { clock, wasReconnecting: current.connection === "reconnecting" };
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

    const { wasReconnecting } = answered.value;

    yield* update((latest) => ({ ...latest, connection: "connected" }));
    const newer = yield* applyClock(answered.value.clock);

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

  if (role === "guest") {
    yield* Effect.forkScoped(
      correct.pipe(Effect.repeat(Schedule.spaced(Duration.millis(tunables.correctionIntervalMs)))),
    );
  } else {
    yield* publish(false);
  }

  const handle: RoomSync = {
    state: SubscriptionRef.changes(state),
    current: SubscriptionRef.get(state),
  };

  return handle;
});
