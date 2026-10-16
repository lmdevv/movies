/**
 * This device's watch room, as the navbar's room pill and the command menu's room commands both
 * read it outside the player. One source, so the two never disagree about which room there is or
 * where returning to it goes.
 */
import type { DeviceId, EpisodeId, ProfileId, RoomId, TitleId } from "@movies/contracts/ids";
import type { Room } from "@movies/contracts/models/rooms";
import { useCommandQuery } from "@movies/sdk/react";
import { useMemo } from "react";

/** What `useCurrentRoom` reports. */
export interface CurrentRoom {
  readonly room: Room;
  /**
   * Whether returning lands in a live room: false while its host is away, when the server has
   * paused it until the host comes back and the player would only say the host left.
   */
  readonly returnable: boolean;
}

/**
 * The live room `deviceId` is in with `profileId`, or null: none, or one it joined with another
 * profile (switching profiles on a device leaves that profile's place to lapse). The server
 * already hides ended rooms, lapsed memberships, rooms of other accounts and devices, and rooms
 * whose title the profile may no longer see; it updates as any of those change. `"skip"` reads
 * nothing, as inside the player, which follows its own room.
 */
export const useCurrentRoom = (
  input: { readonly deviceId: DeviceId; readonly profileId: ProfileId } | "skip",
): CurrentRoom | null => {
  const deviceId = input === "skip" ? null : input.deviceId;
  const profileId = input === "skip" ? null : input.profileId;
  const current = useCommandQuery("rooms.current", deviceId === null ? "skip" : { deviceId });
  const room = current.status === "success" ? current.data : null;

  // Memoized on the record, so callers can depend on the result without re-running every render.
  return useMemo(() => {
    const self = room?.members.find((member) => member.deviceId === deviceId);

    return room === null || self === undefined || self.profileId !== profileId
      ? null
      : { room, returnable: !room.hostAway };
  }, [room, deviceId, profileId]);
};

/** A link into the player for a room, as the router takes it. */
export interface ReturnTarget {
  readonly to: "/watch/$titleId";
  readonly params: { readonly titleId: TitleId };
  readonly search: { readonly room: RoomId; readonly episodeId?: EpisodeId };
}

/**
 * Where Return to room goes: the player on what the room plays now, joined to it. Built from the
 * live record at the moment of returning, so a room that moved to another episode or title while
 * the viewer browsed opens on the new one.
 */
export const returnTarget = (room: Room): ReturnTarget => ({
  to: "/watch/$titleId",
  params: { titleId: room.title.id },
  search: room.episode === null ? { room: room.id } : { room: room.id, episodeId: room.episode.id },
});
