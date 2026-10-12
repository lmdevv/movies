/**
 * Who is in a room and how each person stands, as the room panel lists them: the host first, then
 * this device, then the other guests. Members in step show nothing; a guest more than a second off
 * shows its drift, a joining viewer shows `syncing`, and the host shows `buffering` or `left`.
 */
import type { DeviceId } from "@movies/contracts/ids";
import type { Room } from "@movies/contracts/models/rooms";
import type { RoomMember, RoomMemberStatus } from "@movies/ui/components/room-panel";

import { avatarImage } from "@/lib/avatars";

/** A guest further than this from the shared position shows its drift. */
export const SHOWN_DRIFT_MS = 1_000;

/** `-2.4s` or `+1.2s`. */
export const driftLabel = (driftMs: number): string =>
  `${driftMs < 0 ? "-" : "+"}${(Math.abs(driftMs) / 1000).toFixed(1)}s`;

/** Whether the room is paused because its host went quiet or left. */
export const hostGone = (room: Pick<Room, "hostAway" | "clock">): boolean =>
  room.hostAway || room.clock.status === "ended";

const hostStatus = (room: Room): RoomMemberStatus | undefined => {
  if (hostGone(room)) return { kind: "left" };

  return room.clock.status === "buffering" ? { kind: "buffering" } : undefined;
};

const guestStatus = (
  member: Room["members"][number],
  self: boolean,
  syncing: boolean,
  ownDriftMs: number | null,
): RoomMemberStatus | undefined => {
  if (self && syncing) return { kind: "syncing" };

  const drift = self ? ownDriftMs : member.driftMs;

  return drift !== null && Math.abs(drift) > SHOWN_DRIFT_MS
    ? { kind: "drift", label: driftLabel(drift) }
    : undefined;
};

/**
 * The panel rows for `room` as seen from `deviceId`. `syncing` marks this device still catching
 * up; `ownDriftMs` is its latest measured drift, fresher than what the server last heard.
 */
export const roomMembers = (
  room: Room,
  deviceId: DeviceId,
  syncing: boolean,
  ownDriftMs: number | null,
): ReadonlyArray<RoomMember> => {
  const rank = (member: Room["members"][number]): number =>
    member.role === "host" ? 0 : member.deviceId === deviceId ? 1 : 2;

  const members = room.members.toSorted(
    (left, right) => rank(left) - rank(right) || left.joinedAt - right.joinedAt,
  );

  const rows = members.map((member): RoomMember => {
    const self = member.deviceId === deviceId;
    const host = member.role === "host";

    return {
      id: member.deviceId,
      name: member.profileName,
      detail: host ? "Host" : self ? "You" : undefined,
      avatar: avatarImage(member.avatar),
      status: host ? hostStatus(room) : guestStatus(member, self, syncing, ownDriftMs),
    };
  });

  // The host's row stays after they left, dimmed, so guests know who paused the room.
  const hostListed = room.members.some((member) => member.role === "host");

  return hostListed
    ? rows
    : [
        {
          id: room.hostDeviceId,
          name: room.hostProfileName,
          detail: "Host",
          avatar: undefined,
          status: { kind: "left" },
        },
        ...rows,
      ];
};
