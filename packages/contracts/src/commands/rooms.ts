/**
 * Watch rooms. Only the host's device controls the timeline; every control carries the revision
 * the host last saw and fails with `stale_revision` when the room moved on.
 */
import { Schema } from "effect";

import { DeviceId, EpisodeId, MediaFileId, ProfileId, RoomId, TitleId } from "../ids";
import { NoArgs, Ok } from "../models/common";
import { CreateRoomArgs, HostControlArgs, Room, RoomClock, ServerTime } from "../models/rooms";
import { Milliseconds } from "../units";
import { mutation, query } from "./command";

const OnDevice = Schema.Struct({ roomId: RoomId, deviceId: DeviceId });

/** Watch room commands. */
export const roomCommands = {
  "rooms.create": mutation({
    summary: "Start a watch room for what this device is playing",
    group: "rooms",
    scope: "play",
    args: CreateRoomArgs,
    result: Room,
    function: "rooms:create",
  }),
  "rooms.get": query({
    summary: "Show a room's members and committed clock",
    group: "rooms",
    scope: "read",
    args: Schema.Struct({
      roomId: RoomId,
      /**
       * The profile that would join, for a room this account is not in yet: when it may see the
       * room's title, the room comes back without its members.
       */
      profileId: Schema.optionalKey(ProfileId),
    }),
    result: Room,
    function: "rooms:get",
  }),
  "rooms.current": query({
    summary: "Show the room this device is in",
    group: "rooms",
    scope: "read",
    args: Schema.Struct({ deviceId: DeviceId }),
    result: Schema.NullOr(Room),
    function: "rooms:current",
  }),
  "rooms.join": mutation({
    summary: "Join a room on this device",
    group: "rooms",
    scope: "play",
    args: Schema.Struct({ roomId: RoomId, profileId: ProfileId, deviceId: DeviceId }),
    result: Room,
    function: "rooms:join",
  }),
  "rooms.leave": mutation({
    summary: "Leave a room; the host leaving ends it for everyone",
    group: "rooms",
    scope: "play",
    args: OnDevice,
    result: Ok,
    function: "rooms:leave",
  }),
  "rooms.play": mutation({
    summary: "Play the room from the host's position",
    group: "rooms",
    scope: "play",
    args: HostControlArgs,
    result: RoomClock,
    function: "rooms:play",
  }),
  "rooms.pause": mutation({
    summary: "Pause the room at the host's position",
    group: "rooms",
    scope: "play",
    args: HostControlArgs,
    result: RoomClock,
    function: "rooms:pause",
  }),
  "rooms.seek": mutation({
    summary: "Move the room to a position",
    group: "rooms",
    scope: "play",
    args: HostControlArgs,
    result: RoomClock,
    function: "rooms:seek",
  }),
  "rooms.buffering": mutation({
    summary: "Freeze the room while the host buffers",
    group: "rooms",
    scope: "play",
    args: HostControlArgs,
    result: RoomClock,
    function: "rooms:buffering",
  }),
  "rooms.heartbeat": mutation({
    summary: "Report this device is still in the room; the host also reports its position",
    group: "rooms",
    scope: "play",
    args: Schema.Struct({
      ...OnDevice.fields,
      positionMs: Schema.optionalKey(Milliseconds),
      revision: Schema.optionalKey(Schema.Int),
      /** A guest's distance from the shared position, shown to the room; omit while buffering. */
      driftMs: Schema.optionalKey(Schema.Finite),
    }),
    result: RoomClock,
    function: "rooms:heartbeat",
  }),
  "rooms.setMedia": mutation({
    summary: "Switch the room to another title or episode, paused at the start",
    group: "rooms",
    scope: "play",
    args: Schema.Struct({
      ...OnDevice.fields,
      revision: Schema.Int,
      titleId: TitleId,
      episodeId: Schema.optionalKey(EpisodeId),
      fileId: Schema.optionalKey(MediaFileId),
    }),
    result: RoomClock,
    function: "rooms:setMedia",
  }),
  "rooms.end": mutation({
    summary: "End the room for everyone",
    group: "rooms",
    scope: "play",
    args: OnDevice,
    result: Ok,
    function: "rooms:end",
  }),
  "rooms.time": mutation({
    summary: "Read the server clock to estimate this device's offset",
    group: "rooms",
    scope: "play",
    args: NoArgs,
    result: ServerTime,
    function: "rooms:time",
  }),
};
