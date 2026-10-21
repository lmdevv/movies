/**
 * Keeping this device's place in its watch room while it browses outside the room's player. The
 * server drops a guest silent for `MEMBER_PRESENCE_TIMEOUT_MS` and pauses a room whose host is
 * silent for `HOST_PRESENCE_TIMEOUT_MS`; only the player's room engine sent heartbeats, so a viewer
 * who browsed away for a minute left the room without asking to. These heartbeats say `away`: the
 * device keeps its place, plays nothing, reports no drift, and counts as present but not watching.
 */
import { HEARTBEAT_INTERVAL_MS } from "@movies/contracts/clock";
import type { DeviceId, RoomId } from "@movies/contracts/ids";
import { Cause, Duration, Effect, Predicate, Schedule } from "effect";

import { MoviesClient } from "../movies-client";
import type { CallError } from "../sdk-errors";

/** Which membership to keep. */
export interface RoomPresenceOptions {
  readonly roomId: RoomId;
  readonly deviceId: DeviceId;
  /** Time between heartbeats; `HEARTBEAT_INTERVAL_MS` by default, as the room engine uses. */
  readonly intervalMs?: number;
}

/**
 * Sends an `away` heartbeat for the device's membership now and then every interval, until
 * interrupted. A failed heartbeat is logged and the next one tries again, so one bad answer never
 * costs the device its place: the network, a session being refreshed, a server error, or a
 * moment without the membership (`Forbidden`), as while another tab's player leaves and rejoins.
 * Stop it when the device is no longer in the room, as `rooms.current` reports.
 */
export const keepAway = Effect.fn("RoomPresence.keepAway")(function* (
  options: RoomPresenceOptions,
) {
  const client = yield* MoviesClient;
  const { roomId, deviceId } = options;

  const beat = client.mutate("rooms.heartbeat", { roomId, deviceId, presence: "away" }).pipe(
    Effect.asVoid,
    // The membership or the room gone, until the caller stops: expected, so not a warning.
    Effect.catch((error: CallError) =>
      (Predicate.isTagged(error, "Forbidden") || Predicate.isTagged(error, "NotFound")
        ? Effect.logDebug("RoomPresence.heartbeatRefused", error)
        : Effect.logWarning("RoomPresence.heartbeatFailed", error)
      ).pipe(Effect.annotateLogs({ roomId })),
    ),
  );

  // One heartbeat's defect is reported and the next tries again, as for a failure.
  const kept = beat.pipe(
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterrupts(cause),
      (cause) =>
        Effect.logError("RoomPresence.heartbeatDefect", cause).pipe(
          Effect.annotateLogs({ roomId }),
        ),
    ),
  );

  return yield* kept.pipe(
    Effect.repeat(Schedule.spaced(Duration.millis(options.intervalMs ?? HEARTBEAT_INTERVAL_MS))),
    Effect.asVoid,
  );
});
