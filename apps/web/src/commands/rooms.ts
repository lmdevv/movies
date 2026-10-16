/**
 * Watch room commands: starting, copying the link, leaving, and ending a room from the player;
 * returning to or leaving this device's room from anywhere else; and joining a room whose link is
 * pasted into the menu.
 */
import { RoomId } from "@movies/contracts/ids";
import type { CommandItem } from "@movies/ui/lib/command-menu";
import { useCommand } from "@movies/sdk/react";
import { LinkIcon, LogOutIcon, SquareXIcon, UsersIcon } from "lucide-react";
import { Option, Schema } from "effect";
import { useMemo } from "react";

import { returnTarget, useCurrentRoom } from "@/lib/current-room";
import { loadDeviceId } from "@/lib/device-storage";
import { toastFailure } from "@/lib/failure";

import type { CommandContext, CommandContribution } from "./contribution";

const decodeRoomId = Schema.decodeUnknownOption(RoomId);

/** The room a pasted room link (`…/r/<id>`) names, or none. */
const typedRoomId = (query: string): Option.Option<RoomId> => {
  const match = /\/r\/([a-z0-9]{16,})\/?$/iu.exec(query.trim());

  return match?.[1] === undefined ? Option.none() : decodeRoomId(match[1]);
};

/** Room actions for the menu. */
export const useRoomCommands = (context: CommandContext): CommandContribution => {
  const { navigate, query, player, profile } = context;
  const deviceId = useMemo(() => loadDeviceId(), []);
  const leave = useCommand("rooms.leave");

  const current = useCurrentRoom(player === null ? { deviceId, profileId: profile.id } : "skip");

  return useMemo((): CommandContribution => {
    const typed = typedRoomId(query);

    const join: ReadonlyArray<CommandItem> = Option.match(typed, {
      onNone: () => [],
      onSome: (roomId) => [
        {
          kind: "action",
          id: `room:join:${roomId}`,
          title: "Join room",
          leading: { kind: "icon", icon: UsersIcon },
          perform: () => navigate({ to: "/r/$roomId", params: { roomId } }),
        },
      ],
    });

    if (player !== null) {
      const inPlayer: ReadonlyArray<CommandItem> =
        player.room === null
          ? player.startRoom === null
            ? []
            : [
                {
                  kind: "action",
                  id: "room:start",
                  title: "Watch together",
                  keywords: ["room", "party", "invite", "start"],
                  leading: { kind: "icon", icon: UsersIcon },
                  perform: player.startRoom,
                },
              ]
          : [
              {
                kind: "action",
                id: "room:copy",
                title: "Copy room link",
                keywords: ["invite", "share"],
                leading: { kind: "icon", icon: LinkIcon },
                perform: player.room.copyLink,
              },
              player.room.role === "host"
                ? {
                    kind: "action",
                    id: "room:end",
                    title: "End room",
                    keywords: ["close", "stop"],
                    leading: { kind: "icon", icon: SquareXIcon },
                    perform: player.room.end,
                  }
                : {
                    kind: "action",
                    id: "room:leave",
                    title: "Leave room",
                    leading: { kind: "icon", icon: LogOutIcon },
                    perform: player.room.leave,
                  },
            ];

      return { groups: [{ id: "room", label: "Room", items: inPlayer }], fallback: join };
    }

    const room = current?.room ?? null;

    const back: ReadonlyArray<CommandItem> =
      room === null || current?.returnable !== true
        ? []
        : [
            {
              kind: "action",
              id: "room:return",
              title: "Return to room",
              detail: room.title.name,
              leading: { kind: "icon", icon: UsersIcon },
              perform: () => navigate(returnTarget(room)),
            },
          ];

    const elsewhere: ReadonlyArray<CommandItem> =
      room === null
        ? []
        : [
            ...back,
            {
              kind: "action",
              id: "room:leave",
              title: "Leave room",
              detail: room.title.name,
              leading: { kind: "icon", icon: LogOutIcon },
              perform: () =>
                leave({ roomId: room.id, deviceId }).then(() => undefined, toastFailure),
            },
          ];

    return { groups: [{ id: "room", label: "Room", items: elsewhere }], fallback: join };
  }, [navigate, query, player, current, leave, deviceId]);
};
