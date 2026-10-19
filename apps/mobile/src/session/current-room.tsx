/**
 * This device's watch room, as Home's room pill (C17) reads it outside the player. One subscription
 * for the whole app, which also keeps the device's place in the room while it browses: the server
 * drops a silent guest and pauses a room whose host goes silent, so heartbeats say the device is
 * away rather than gone. The room's player sends its own heartbeats; the server lets those win.
 */
import type { RoomId } from "@movies/contracts/ids";
import { useCommandQuery, useRoomPresence } from "@movies/sdk/react";
import { createContext, useContext, useMemo } from "react";
import type { ReactNode } from "react";

import { deviceId } from "@/lib/device";

import { ActiveProfileContext } from "./active-profile";

/** The room this device is in, reduced to what the pill shows and where it leads. */
export interface CurrentRoom {
  readonly id: RoomId;
  /** How many are in the room, members browsing elsewhere included. */
  readonly members: number;
}

const CurrentRoomContext = createContext<CurrentRoom | null>(null);

/**
 * Reads the room this device joined with the active profile, and keeps its place there. The server
 * hides ended rooms, lapsed memberships, and rooms no profile the device joined with may still see;
 * a room joined with another profile is that profile's, and is left to lapse.
 */
export function CurrentRoomProvider({ children }: { readonly children: ReactNode }) {
  const active = useContext(ActiveProfileContext);
  const device = deviceId();
  const read = useCommandQuery("rooms.current", active === null ? "skip" : { deviceId: device });
  const room = read.status === "success" ? read.data : null;

  const mine =
    room !== null &&
    active !== null &&
    room.members.some(
      (member) => member.deviceId === device && member.profileId === active.profile.id,
    );

  const id = mine ? room.id : null;
  const members = room?.members.length ?? 0;

  useRoomPresence(id === null ? null : { roomId: id, deviceId: device });

  // Every member's heartbeat changes the record; the pill changes only with what it shows.
  const current = useMemo(() => (id === null ? null : { id, members }), [id, members]);

  return <CurrentRoomContext value={current}>{children}</CurrentRoomContext>;
}

/** This device's room, inside `CurrentRoomProvider`; null without one. */
export const useCurrentRoom = (): CurrentRoom | null => useContext(CurrentRoomContext);
