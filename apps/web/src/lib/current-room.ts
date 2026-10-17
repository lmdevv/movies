/**
 * This device's watch room, as the navbar's room pill and the command menu's room commands both
 * read it outside the player. One source, so the two never disagree about which room there is or
 * where returning to it goes.
 */
import type { DeviceId, EpisodeId, ProfileId, RoomId, TitleId } from "@movies/contracts/ids";
import { useCommandQuery } from "@movies/sdk/react";
import { useMemo } from "react";

/** The room this device is in, reduced to what the pill and the menu show. */
export interface CurrentRoom {
  readonly id: RoomId;
  readonly titleId: TitleId;
  readonly titleName: string;
  /** The episode the room plays, for shows. */
  readonly episodeId: EpisodeId | null;
  /** How many are in the room, away members included. */
  readonly members: number;
  /**
   * Whether the device is in the room with the active profile. Only then is the room shown,
   * offered to return to, or kept with heartbeats; another profile can only leave it.
   */
  readonly mine: boolean;
  /**
   * Whether returning lands in a live room: false while its host is away, when the server has
   * paused it until the host comes back and the player would only say the host left.
   */
  readonly returnable: boolean;
}

/**
 * The live room `deviceId` is in, or null. The server already hides ended rooms, lapsed
 * memberships, rooms of other accounts and devices, and rooms whose title no profile the device
 * joined with may still see, and it updates as any of those change. `mine` says whether the
 * device joined with `profileId`: switching profiles leaves the other profile's place to lapse.
 * `"skip"` reads nothing, as inside the player, which follows its own room.
 *
 * Every member's heartbeat changes the room record, so the result is rebuilt only when something
 * it holds changes.
 */
export const useCurrentRoom = (
  input: { readonly deviceId: DeviceId; readonly profileId: ProfileId } | "skip",
): CurrentRoom | null => {
  const deviceId = input === "skip" ? null : input.deviceId;
  const profileId = input === "skip" ? null : input.profileId;
  const current = useCommandQuery("rooms.current", deviceId === null ? "skip" : { deviceId });
  const room = current.status === "success" ? current.data : null;
  const self = room?.members.find((member) => member.deviceId === deviceId);
  const id = room?.id ?? null;
  const titleId = room?.title.id ?? null;
  const titleName = room?.title.name ?? "";
  const episodeId = room?.episode?.id ?? null;
  const members = room?.members.length ?? 0;
  const mine = self !== undefined && self.profileId === profileId;
  const returnable = room !== null && !room.hostAway;

  return useMemo(
    () =>
      id === null || titleId === null
        ? null
        : { id, titleId, titleName, episodeId, members, mine, returnable },
    [id, titleId, titleName, episodeId, members, mine, returnable],
  );
};

/** A link into the player for a room, as the router takes it. */
export interface ReturnTarget {
  readonly to: "/watch/$titleId";
  readonly params: { readonly titleId: TitleId };
  readonly search: { readonly room: RoomId; readonly episodeId?: EpisodeId };
}

/**
 * Where returning to a room goes: the player on what the room plays now, joined to it. Built from
 * the live record, so a room that moved to another episode or title while the viewer browsed opens
 * on the new one.
 */
export const returnTarget = (room: {
  readonly id: RoomId;
  readonly titleId: TitleId;
  readonly episodeId: EpisodeId | null;
}): ReturnTarget => ({
  to: "/watch/$titleId",
  params: { titleId: room.titleId },
  search:
    room.episodeId === null ? { room: room.id } : { room: room.id, episodeId: room.episodeId },
});
