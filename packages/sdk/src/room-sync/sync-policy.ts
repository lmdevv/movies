/**
 * Decisions for keeping one player on a room's shared timeline: what a following player should
 * do to reach the committed clock, and which host command a host player's state calls for. Pure:
 * every input is a value, including the server time, so the engine and tests share one source of
 * truth.
 */
import type { ClockAnchor } from "@movies/contracts/clock";
import { DRIFT_THRESHOLDS, HEARTBEAT_INTERVAL_MS, targetPosition } from "@movies/contracts/clock";
import type { EpochMillis } from "@movies/contracts/units";
import { Milliseconds } from "@movies/contracts/units";
import { Data, Option } from "effect";

/**
 * Tuning parameters for room synchronization. The defaults are starting points from the
 * architecture's playback spike; measure drift and recovery before changing them.
 */
export interface RoomSyncTunables {
  /** Within this distance a follower is in sync and runs at the room's rate. */
  readonly inSyncMs: number;
  /** Beyond this distance a follower seeks; between the two it nudges its rate. */
  readonly seekMs: number;
  /** How far from the room's rate a nudging follower runs, as a fraction. */
  readonly nudgeRate: number;
  /** How often a follower measures drift between clock changes. */
  readonly correctionIntervalMs: number;
  /** After a seek a follower only nudges for this long, so slow seeks do not loop. */
  readonly seekCooldownMs: number;
  /** A host seek further than this from the shared position becomes a room seek. */
  readonly hostSeekMs: number;
  /** How often members report presence; the host also reports its position. */
  readonly heartbeatIntervalMs: number;
  /** A heartbeat unanswered this long marks the connection lost and disables host controls. */
  readonly heartbeatTimeoutMs: number;
  /** Server clock readings per offset estimate; the one with the shortest round trip wins. */
  readonly offsetSamples: number;
  /** Pause between the readings of one estimate. */
  readonly offsetSampleSpacingMs: number;
  /** How often the offset is estimated again, to follow clock drift and better routes. */
  readonly offsetRefreshIntervalMs: number;
  /** Wait before reopening a failed room subscription. */
  readonly resubscribeDelayMs: number;
}

/** The default tunables, using the contracts' drift thresholds and heartbeat cadence. */
export const DEFAULT_TUNABLES: RoomSyncTunables = {
  inSyncMs: DRIFT_THRESHOLDS.inSyncMs,
  seekMs: DRIFT_THRESHOLDS.seekMs,
  nudgeRate: DRIFT_THRESHOLDS.nudgeRate,
  correctionIntervalMs: 500,
  seekCooldownMs: 3_000,
  hostSeekMs: 1_000,
  heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
  heartbeatTimeoutMs: 4_000,
  offsetSamples: 5,
  offsetSampleSpacingMs: 50,
  offsetRefreshIntervalMs: 30_000,
  resubscribeDelayMs: 1_000,
};

/** What a player reports at one instant. */
export interface PlayerSnapshot {
  readonly positionMs: number;
  readonly paused: boolean;
  /** Stalled waiting for data while meant to play. */
  readonly buffering: boolean;
  readonly playbackRate: number;
}

/** One change to make to a player. */
export type PlayerCommand = Data.TaggedEnum<{
  Seek: { readonly positionMs: Milliseconds };
  Play: {};
  Pause: {};
  SetRate: { readonly rate: number };
}>;

/** Constructors and matchers for `PlayerCommand`. */
export const PlayerCommand = Data.taggedEnum<PlayerCommand>();

/** What a follower should do now, and how far off it was. */
export interface FollowDecision {
  readonly commands: ReadonlyArray<PlayerCommand>;
  /** Player position minus the shared position; positive means ahead. Null while buffering. */
  readonly driftMs: number | null;
}

/** Whether two rates differ enough to be worth setting. */
const rateDiffers = (a: number, b: number): boolean => Math.abs(a - b) > 1e-6;

/** Commands that hold a player still at `positionMs`. */
const holdAt = (
  player: PlayerSnapshot,
  positionMs: Milliseconds,
  clock: ClockAnchor,
  tunables: RoomSyncTunables,
): FollowDecision => {
  const driftMs = player.positionMs - positionMs;

  const commands = [
    ...(player.paused ? [] : [PlayerCommand.Pause()]),
    ...(Math.abs(driftMs) > tunables.inSyncMs ? [PlayerCommand.Seek({ positionMs })] : []),
    ...(rateDiffers(player.playbackRate, clock.playbackRate)
      ? [PlayerCommand.SetRate({ rate: clock.playbackRate })]
      : []),
  ];

  return { commands, driftMs };
};

/**
 * Brings a following player toward the committed clock at `serverNow`. A stopped room holds the
 * player at the anchor. A playing room leaves a buffering player alone, seeks when far off
 * (unless a seek just happened), nudges the rate when moderately off, and runs at the room's rate
 * when in sync; a paused player also starts playing.
 */
export const follow = (
  clock: ClockAnchor,
  serverNow: EpochMillis,
  player: PlayerSnapshot,
  recentlySought: boolean,
  tunables: RoomSyncTunables,
): FollowDecision => {
  const target = targetPosition(clock, serverNow);

  if (clock.status !== "playing") return holdAt(player, target, clock, tunables);

  if (player.buffering) return { commands: [], driftMs: null };
  const driftMs = player.positionMs - target;
  const distance = Math.abs(driftMs);
  const play = player.paused ? [PlayerCommand.Play()] : [];

  if (distance >= tunables.seekMs && !recentlySought) {
    const rate = rateDiffers(player.playbackRate, clock.playbackRate)
      ? [PlayerCommand.SetRate({ rate: clock.playbackRate })]
      : [];

    return { commands: [PlayerCommand.Seek({ positionMs: target }), ...rate, ...play], driftMs };
  }

  const wanted =
    distance <= tunables.inSyncMs
      ? clock.playbackRate
      : clock.playbackRate * (1 + (driftMs > 0 ? -1 : 1) * tunables.nudgeRate);

  const rate = rateDiffers(player.playbackRate, wanted)
    ? [PlayerCommand.SetRate({ rate: wanted })]
    : [];

  return { commands: [...rate, ...play], driftMs };
};

/** A room command a host player's state calls for. */
export interface HostCommand {
  readonly command: "rooms.play" | "rooms.pause" | "rooms.seek" | "rooms.buffering";
  readonly positionMs: Milliseconds;
}

/**
 * Compares the host's player with the committed clock and names the command that would make the
 * room match it, or none. Comparing state rather than replaying player events means the engine's
 * own corrections, which leave the player matching the clock, never echo back as commands. A seek
 * counts only after a `seeked` event and only when it moved further than `hostSeekMs`.
 */
export const hostIntent = (
  clock: ClockAnchor,
  serverNow: EpochMillis,
  player: PlayerSnapshot,
  seeked: boolean,
  tunables: RoomSyncTunables,
): Option.Option<HostCommand> => {
  if (clock.status === "ended") return Option.none();
  const positionMs = Milliseconds.make(Math.max(0, player.positionMs));
  const at = (command: HostCommand["command"]) => Option.some<HostCommand>({ command, positionMs });

  const moved =
    Math.abs(player.positionMs - targetPosition(clock, serverNow)) > tunables.hostSeekMs;

  const seek = seeked && moved ? at("rooms.seek") : Option.none();

  if (!player.paused && player.buffering) {
    return clock.status === "playing" ? at("rooms.buffering") : Option.none();
  }

  if (!player.paused) return clock.status === "playing" ? seek : at("rooms.play");

  return clock.status === "playing" || clock.status === "buffering" ? at("rooms.pause") : seek;
};

/** A short name for a player command, for logs. */
export const commandLabel: (command: PlayerCommand) => string = PlayerCommand.$match({
  Seek: () => "seek",
  Play: () => "play",
  Pause: () => "pause",
  SetRate: () => "rate",
});
