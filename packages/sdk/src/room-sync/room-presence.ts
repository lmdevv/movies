/**
 * Keeping this device's place in its watch room while it browses outside the room's player. The
 * server drops a guest silent for `MEMBER_PRESENCE_TIMEOUT_MS` and pauses a room whose host is
 * silent for `HOST_PRESENCE_TIMEOUT_MS`; only the player's room engine sent heartbeats, so a viewer
 * who browsed away for a minute left the room without asking to. These heartbeats say `away`: the
 * device keeps its place, plays nothing, reports no drift, and counts as present but not watching.
 */
import { HEARTBEAT_INTERVAL_MS } from "@movies/contracts/clock";
import type { DeviceId, RoomId } from "@movies/contracts/ids";
import { Duration, Effect, Schedule } from "effect";

import { MoviesClient } from "../movies-client";
import type { CallError } from "../sdk-errors";
import { isTransient } from "../sdk-errors";

/** Which membership to keep. */
export interface RoomPresenceOptions {
  readonly roomId: RoomId;
  readonly deviceId: DeviceId;
  /** Time between heartbeats; `HEARTBEAT_INTERVAL_MS` by default, as the room engine uses. */
  readonly intervalMs?: number;
}

/**
 * Sends an `away` heartbeat for the device's membership now and then every interval, until
 * interrupted. A transient failure (the network, rate limiting) is logged and the next heartbeat
 * tries again. Any other failure ends it with that error: the membership is gone (`Forbidden`) or
 * the room is (`NotFound`), and retrying would not bring either back.
 */
export const keepAway = Effect.fn("RoomPresence.keepAway")(function* (
  options: RoomPresenceOptions,
) {
  const client = yield* MoviesClient;
  const { roomId, deviceId } = options;

  const beat = client.mutate("rooms.heartbeat", { roomId, deviceId, presence: "away" }).pipe(
    Effect.asVoid,
    Effect.catchIf(isTransient, (error: CallError) =>
      Effect.logWarning("RoomPresence.heartbeatFailed", error).pipe(
        Effect.annotateLogs({ roomId }),
      ),
    ),
  );

  return yield* beat.pipe(
    Effect.repeat(Schedule.spaced(Duration.millis(options.intervalMs ?? HEARTBEAT_INTERVAL_MS))),
    Effect.asVoid,
  );
});
