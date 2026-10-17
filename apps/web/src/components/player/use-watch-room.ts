/**
 * A watch room as the player needs it before playback: join it on this device and follow its
 * record. The server enforces who may join and who controls the timeline; this hook only turns its
 * answers into states. The SDK's `useRoomSync` keeps the player on the room's timeline after.
 */
import type { DeviceId, ProfileId, RoomId } from "@movies/contracts/ids";
import type { Room } from "@movies/contracts/models/rooms";
import { HEARTBEAT_INTERVAL_MS } from "@movies/contracts/clock";
import { useCommand, useCommandQuery } from "@movies/sdk/react";
import { Predicate } from "effect";
import { useEffect, useState } from "react";

import type { RoomDenial } from "./room-states";

/** Where joining stands. */
type RoomJoin =
  | { readonly status: "joining" }
  | { readonly status: "joined" }
  | { readonly status: "denied"; readonly denial: RoomDenial };

/** A room the player is in, or is joining. */
export interface WatchRoom {
  readonly join: RoomJoin;
  /** The room's record, once read. */
  readonly room: Room | null;
}

/**
 * Joins `roomId` with `profileId` on `deviceId` and follows the room. A room the profile cannot
 * see, or that ended before joining, comes back denied; null without a room.
 */
export const useWatchRoom = (
  roomId: RoomId | null,
  profileId: ProfileId,
  deviceId: DeviceId,
): WatchRoom | null => {
  const joinRoom = useCommand("rooms.join");
  const [join, setJoin] = useState<RoomJoin>({ status: "joining" });
  const record = useCommandQuery("rooms.get", roomId === null ? "skip" : { roomId, profileId });
  const room = record.status === "success" ? record.data : null;

  // A joined room that stops answering moved on out of this profile's reach. A failed read stays
  // failed, so it is read again every heartbeat interval, until the room plays something this
  // profile may watch again, or ends.
  const outOfReach =
    record.status === "error" &&
    Predicate.isTagged(record.error, "NotFound") &&
    join.status === "joined";

  const retry = outOfReach ? record.retry : null;

  useEffect(() => {
    if (retry === null) return undefined;

    const timer = setInterval(retry, HEARTBEAT_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [retry]);

  useEffect(() => {
    if (roomId === null) return undefined;

    let active = true;

    setJoin({ status: "joining" });
    joinRoom({ roomId, profileId, deviceId }).then(
      () => {
        if (active) setJoin({ status: "joined" });

        return undefined;
      },
      (cause: unknown) => {
        if (!active) return;

        setJoin({
          status: "denied",
          denial: Predicate.isTagged(cause, "Conflict")
            ? { kind: "ended", hostName: "The host" }
            : { kind: "household", hostName: null },
        });
      },
    );

    return () => {
      active = false;
    };
  }, [joinRoom, roomId, profileId, deviceId]);

  if (roomId === null) return null;

  // A room that ended while this member was out of reach of what it played.
  if (record.status === "error" && Predicate.isTagged(record.error, "Conflict")) {
    return {
      join: { status: "denied", denial: { kind: "ended", hostName: "The host" } },
      room: null,
    };
  }

  // A room this account cannot read at all belongs to another household. One this device joined
  // that stops answering moved on to something the profile it joined with may not watch; it
  // answers again once the room plays something that profile may.
  if (record.status === "error" && Predicate.isTagged(record.error, "NotFound")) {
    return {
      join: {
        status: "denied",
        denial: outOfReach
          ? { kind: "unavailable", hostName: null }
          : { kind: "household", hostName: null },
      },
      room: null,
    };
  }

  // A join refused as ended or for another household names the host once the room could be read.
  const named = (denial: RoomDenial): RoomDenial =>
    room === null || denial.kind === "unavailable"
      ? denial
      : { ...denial, hostName: room.hostProfileName };

  return {
    join: join.status === "denied" ? { status: "denied", denial: named(join.denial) } : join,
    room,
  };
};
