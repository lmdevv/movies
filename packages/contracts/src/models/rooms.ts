/** Watch rooms: a shared, host-controlled timeline that members follow on their own streams. */
import { Schema } from "effect";

import { DeviceId, EpisodeId, MediaFileId, ProfileId, RoomId, TitleId, UserId } from "../ids";
import { EpochMillis, Milliseconds } from "../units";
import { Episode, TitleCard } from "./catalog";

/** Room playback state. Buffering freezes the shared position like a pause. */
export const RoomStatus = Schema.Literals(["playing", "paused", "buffering", "ended"]);

/** Room playback state. */
export type RoomStatus = typeof RoomStatus.Type;

/**
 * The committed shared timeline. Clients compute the live position with `targetPosition` from
 * `@movies/contracts/clock` and apply clocks in `revision` order.
 */
export const RoomClock = Schema.Struct({
  status: RoomStatus,
  positionAtAnchorMs: Milliseconds,
  anchorServerTime: EpochMillis,
  playbackRate: Schema.Finite.check(Schema.isGreaterThan(0)),
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

/** The committed shared timeline. */
export interface RoomClock extends Schema.Schema.Type<typeof RoomClock> {}

/** A room member: one profile on one device. */
export const RoomMember = Schema.Struct({
  userId: UserId,
  profileId: ProfileId,
  profileName: Schema.String,
  avatar: Schema.String,
  deviceId: DeviceId,
  role: Schema.Literals(["host", "guest"]),
  joinedAt: EpochMillis,
  lastSeenAt: EpochMillis,
});

/** A room member. */
export interface RoomMember extends Schema.Schema.Type<typeof RoomMember> {}

/** A watch room as members and invited account holders see it. */
export const Room = Schema.Struct({
  id: RoomId,
  title: TitleCard,
  episode: Schema.NullOr(Episode),
  fileId: MediaFileId,
  hostUserId: UserId,
  hostProfileId: ProfileId,
  hostDeviceId: DeviceId,
  /** The host stopped sending heartbeats; the server paused the room until the host returns. */
  hostAway: Schema.Boolean,
  clock: RoomClock,
  members: Schema.Array(RoomMember),
  createdAt: EpochMillis,
});

/** A watch room. */
export interface Room extends Schema.Schema.Type<typeof Room> {}

/** Host control arguments: the room, the host's device, the revision the host last saw, and its position. */
export const HostControlArgs = Schema.Struct({
  roomId: RoomId,
  deviceId: DeviceId,
  revision: Schema.Int,
  positionMs: Milliseconds,
});

/** The server's clock reading, for estimating the offset between device and server clocks. */
export const ServerTime = Schema.Struct({ serverTime: EpochMillis });

/** Arguments to start a room for a title the host is about to play or is playing. */
export const CreateRoomArgs = Schema.Struct({
  profileId: ProfileId,
  deviceId: DeviceId,
  titleId: TitleId,
  episodeId: Schema.optionalKey(EpisodeId),
  fileId: Schema.optionalKey(MediaFileId),
  positionMs: Milliseconds,
});
