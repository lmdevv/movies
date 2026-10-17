/**
 * Watch rooms. Only the host's device controls the timeline; every control carries the revision
 * the host last saw and fails with `stale_revision` when the room moved on. The next-episode
 * commands are keyed on what the room plays instead, so a repeat or a race moves it on once.
 */
import { Schema } from "effect";

import { DeviceId, EpisodeId, MediaFileId, ProfileId, RoomId, TitleId } from "../ids";
import { NoArgs, Ok } from "../models/common";
import {
  CreateRoomArgs,
  HostControlArgs,
  Room,
  RoomClock,
  RoomPresence,
  ServerTime,
} from "../models/rooms";
import { EpochMillis, Milliseconds } from "../units";
import { mutation, query } from "./command";

const OnDevice = Schema.Struct({ roomId: RoomId, deviceId: DeviceId });

/**
 * A next-episode command: the room, the host's device, and the episode the host is moving on from.
 * When the room already plays another, it moved on before the command, which then changes nothing:
 * repeats, races with the countdown, and stale tabs act once, on the episode they meant.
 */
const FromEpisode = Schema.Struct({ ...OnDevice.fields, fromEpisodeId: EpisodeId });

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
      /**
       * When the host read `positionMs`, by its estimate of the server clock, so the server carries
       * the position forward instead of counting the request's travel time as drift.
       */
      atServerTime: Schema.optionalKey(EpochMillis),
      revision: Schema.optionalKey(Schema.Int),
      /**
       * The file the host's player plays; a position read on a file the room moved on from never
       * re-anchors the new one's clock.
       */
      fileId: Schema.optionalKey(MediaFileId),
      /** A guest's distance from the shared position, shown to the room; omit while buffering. */
      driftMs: Schema.optionalKey(Schema.Finite),
      /**
       * `away` from a device browsing elsewhere in the app, which keeps its place without playing;
       * omit from the room's player. It counts once the device's player has been silent for
       * `PLAYER_SILENCE_MS`; until then it only keeps the place. An away host's position is not
       * read.
       */
      presence: Schema.optionalKey(RoomPresence),
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
  "rooms.startNextCountdown": mutation({
    summary:
      "Host: start the room's countdown to the next episode; the server moves everyone on when it ends",
    group: "rooms",
    scope: "play",
    args: FromEpisode,
    result: Room,
    function: "rooms:startNextCountdown",
  }),
  "rooms.cancelNextCountdown": mutation({
    summary: "Host: cancel the next-episode countdown for everyone, to watch the credits",
    group: "rooms",
    scope: "play",
    args: FromEpisode,
    result: Room,
    function: "rooms:cancelNextCountdown",
  }),
  "rooms.playNext": mutation({
    summary: "Host: move the room on to the next episode now; once per episode",
    group: "rooms",
    scope: "play",
    args: FromEpisode,
    result: Room,
    function: "rooms:playNext",
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
