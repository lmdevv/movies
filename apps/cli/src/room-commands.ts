/**
 * Watch room shortcuts. The CLI has no player of its own, so host controls act on the room's live
 * position: `pause` freezes it where the room is now, `play` resumes from there or `--position`.
 * Each control reads the room first and sends its current revision; a revision that moved on in
 * between is read again and retried once.
 */
import type { ClockOffset } from "@movies/contracts/clock";
import {
  countdownRemaining,
  estimateClockOffset,
  targetPosition,
  toServerTime,
} from "@movies/contracts/clock";
import { commands } from "@movies/contracts/commands";
import { NotFound } from "@movies/contracts/errors";
import type { ProfileId } from "@movies/contracts/ids";
import { EpisodeId, RoomId } from "@movies/contracts/ids";
import type { Room, RoomClock } from "@movies/contracts/models/rooms";
import type { EpochMillis, Milliseconds } from "@movies/contracts/units";
import { Milliseconds as MillisecondsSchema } from "@movies/contracts/units";
import { Clock, Effect, Option, Ref, Stream } from "effect";

import type { Invocation, ShortcutCommand } from "./invocation";
import {
  booleanFlag,
  encodeResult,
  Outcome,
  positionalText,
  positionFlag,
  requirePositional,
  resultOutcome,
  stringFlag,
  textOutcome,
  usage,
  viewingProfile,
  viewingProfileIfAny,
} from "./invocation";
import { Output } from "./output";
import { formatDuration } from "./render";
import type { Connection } from "./session";
import { connect } from "./session";
import { findTitle } from "./watch-commands";

/**
 * Arguments to read a room: its ID and, for a room this account has not joined, the profile that
 * would join, which must be able to see its title.
 */
const roomQuery = (roomId: RoomId, profileId: Option.Option<ProfileId>) =>
  Option.match(profileId, {
    onNone: () => ({ roomId }),
    onSome: (id) => ({ roomId, profileId: id }),
  });

/**
 * The room named on the command line, read as `profileId` would join it, or the one this device
 * is in.
 */
const resolveRoom = Effect.fn("Rooms.resolve")(function* (
  invocation: Invocation,
  connection: Connection,
  profileId: Option.Option<ProfileId>,
) {
  const named = positionalText(invocation.tokens);

  if (Option.isSome(named)) {
    return yield* connection.withSession(
      connection.client.query("rooms.get", roomQuery(RoomId.make(named.value), profileId)),
    );
  }

  const current = yield* connection.withSession(
    connection.client.query("rooms.current", { deviceId: connection.deviceId }),
  );

  if (current === null) {
    return yield* new NotFound({ message: "This device is in no room; pass a room ID" });
  }

  return current;
});

/** This machine's clock taken as the server's, when `rooms.time` is not available. */
const LOCAL_CLOCK: ClockOffset = { offsetMs: 0, roundTripMs: 0 };

/** How long `rooms status --watch` trusts a clock measurement before taking another. */
const REMEASURE_AFTER_MS = 5 * 60_000;

/**
 * How far the server's clock runs ahead of this machine's, from one `rooms.time` round trip,
 * assuming the server read its clock halfway through it. When this session may not call
 * `rooms.time`, trusts this machine's clock.
 */
const measureClockOffset = Effect.fn("Rooms.measureClock")(function* (connection: Connection) {
  const sentAt = yield* Clock.currentTimeMillis;

  return yield* connection.client.mutate("rooms.time", {}).pipe(
    Effect.flatMap(({ serverTime }) =>
      Effect.map(
        Clock.currentTimeMillis,
        (receivedAt) => estimateClockOffset([{ sentAt, serverTime, receivedAt }]) ?? LOCAL_CLOCK,
      ),
    ),
    Effect.orElseSucceed(() => LOCAL_CLOCK),
  );
});

/** The room's live position now, by the server's clock. */
const livePosition = (offset: ClockOffset, clock: RoomClock): Effect.Effect<Milliseconds> =>
  Effect.map(Clock.currentTimeMillis, (now) => targetPosition(clock, toServerTime(now, offset)));

type HostCommand = "rooms.play" | "rooms.pause" | "rooms.seek";

/** Sends a host control at the room's current revision, retrying once after a stale revision. */
const control = Effect.fn("Rooms.control")(function* (
  invocation: Invocation,
  name: HostCommand,
  position: (connection: Connection, room: Room) => Effect.Effect<Milliseconds>,
) {
  const connection = yield* connect(invocation.env, invocation.target, "required");

  const send = Effect.gen(function* () {
    const room = yield* resolveRoom(invocation, connection, connection.viewingProfileId);
    const positionMs = yield* position(connection, room);

    return yield* connection.withSession(
      connection.client.mutate(name, {
        roomId: room.id,
        deviceId: connection.deviceId,
        revision: room.clock.revision,
        positionMs,
      }),
    );
  });

  const clock = yield* send.pipe(Effect.catchTag("StaleRevision", () => send));

  return resultOutcome(commands[name], yield* encodeResult(name, commands[name], clock));
});

/** A host control whose position comes from `--position` or the live position. */
const hostControl = (
  path: string,
  name: HostCommand,
  requirePosition: boolean,
): ShortcutCommand => ({
  path,
  options: { position: { type: "string" } },
  positionals: true,
  run: (invocation) =>
    Effect.gen(function* () {
      const flag = yield* positionFlag(invocation, "position");

      if (requirePosition && Option.isNone(flag)) {
        return yield* usage(invocation, `${path} needs --position <seconds or h:mm:ss>`);
      }

      return yield* control(invocation, name, (connection, room) =>
        Option.match(flag, {
          onNone: () =>
            Effect.flatMap(measureClockOffset(connection), (offset) =>
              livePosition(offset, room.clock),
            ),
          onSome: Effect.succeed,
        }),
      );
    }),
});

const create: ShortcutCommand = {
  path: "rooms create",
  options: {
    "episode-id": { type: "string" },
    position: { type: "string" },
    "profile-id": { type: "string" },
  },
  positionals: true,
  run: (invocation) =>
    Effect.gen(function* () {
      const query = yield* requirePositional(invocation, "a title name or ID");
      const position = yield* positionFlag(invocation, "position");
      const connection = yield* connect(invocation.env, invocation.target, "required");
      const profileId = yield* viewingProfile(invocation, connection.viewingProfileId);
      const title = yield* findTitle(connection, profileId, query);

      const room = yield* connection.withSession(
        connection.client.mutate("rooms.create", {
          profileId,
          deviceId: connection.deviceId,
          titleId: title.id,
          positionMs: Option.getOrElse(position, () => MillisecondsSchema.make(0)),
          ...Option.match(stringFlag(invocation.tokens, "episode-id"), {
            onNone: () => ({}),
            onSome: (id) => ({ episodeId: EpisodeId.make(id) }),
          }),
        }),
      );

      return resultOutcome(
        commands["rooms.create"],
        yield* encodeResult("rooms.create", commands["rooms.create"], room),
      );
    }),
};

const join: ShortcutCommand = {
  path: "rooms join",
  options: { "profile-id": { type: "string" } },
  positionals: true,
  run: (invocation) =>
    Effect.gen(function* () {
      const roomId = RoomId.make(yield* requirePositional(invocation, "a room ID"));
      const connection = yield* connect(invocation.env, invocation.target, "required");
      const profileId = yield* viewingProfile(invocation, connection.viewingProfileId);

      const room = yield* connection.withSession(
        connection.client.mutate("rooms.join", {
          roomId,
          profileId,
          deviceId: connection.deviceId,
        }),
      );

      return resultOutcome(
        commands["rooms.join"],
        yield* encodeResult("rooms.join", commands["rooms.join"], room),
      );
    }),
};

const leave: ShortcutCommand = {
  path: "rooms leave",
  options: {},
  positionals: true,
  run: (invocation) =>
    Effect.gen(function* () {
      const connection = yield* connect(invocation.env, invocation.target, "required");
      const room = yield* resolveRoom(invocation, connection, connection.viewingProfileId);

      yield* connection.withSession(
        connection.client.mutate("rooms.leave", { roomId: room.id, deviceId: connection.deviceId }),
      );

      return textOutcome({ ok: true, roomId: room.id }, `Left room ${room.id}.`);
    }),
};

/** The room's next-episode countdown in a line, or null while there is none. */
const describeNext = (room: Room, serverNow: EpochMillis): string | null => {
  if (room.next === null) return null;

  if (room.next.status === "cancelled") return "  next episode: cancelled (watching the credits)";
  const { episode, nextAt } = room.next;
  const seconds = Math.ceil(countdownRemaining(nextAt, serverNow) / 1000);

  return `  next episode: S${String(episode.seasonNumber)}:E${String(episode.episodeNumber)} ${episode.name} in ${String(seconds)}s`;
};

const describeRoom = (room: Room, liveMs: number, serverNow: EpochMillis): string =>
  [
    `${room.title.name}${room.episode === null ? "" : ` S${String(room.episode.seasonNumber)}:E${String(room.episode.episodeNumber)} ${room.episode.name}`} · ${room.clock.status} at ${formatDuration(liveMs)} · revision ${String(room.clock.revision)}${room.hostAway ? " · host away" : ""}`,
    ...[describeNext(room, serverNow)].filter((line) => line !== null),
    ...room.members.map(
      (member) =>
        `  ${member.role === "host" ? "host " : "guest"} ${member.profileName} (${member.deviceId})${member.presence === "away" ? " · away" : ""}`,
    ),
  ].join("\n");

const status: ShortcutCommand = {
  path: "rooms status",
  options: { watch: { type: "boolean" }, "profile-id": { type: "string" } },
  positionals: true,
  run: (invocation) =>
    Effect.gen(function* () {
      const output = yield* Output;
      const connection = yield* connect(invocation.env, invocation.target, "required");

      const profileId = viewingProfileIfAny(invocation, connection.viewingProfileId);

      const room = yield* resolveRoom(invocation, connection, profileId);
      const command = commands["rooms.get"];

      const measured = yield* Ref.make({
        offset: yield* measureClockOffset(connection),
        at: yield* Clock.currentTimeMillis,
      });

      // Not a `rooms.time` call per change: a measurement serves for a few minutes of watching.
      const currentOffset = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const last = yield* Ref.get(measured);

        if (now - last.at < REMEASURE_AFTER_MS) return last.offset;
        const offset = yield* measureClockOffset(connection);

        yield* Ref.set(measured, { offset, at: now });

        return offset;
      });

      const snapshot = Effect.fn("Rooms.snapshot")(function* (current: Room) {
        const offset = yield* currentOffset;
        const live = yield* livePosition(offset, current.clock);
        const serverNow = toServerTime(yield* Clock.currentTimeMillis, offset);

        return {
          json: { room: yield* encodeResult("rooms.get", command, current), livePositionMs: live },
          human: describeRoom(current, live, serverNow),
        };
      });

      if (!booleanFlag(invocation.tokens, "watch")) {
        const shown = yield* snapshot(room);

        return textOutcome(shown.json, shown.human);
      }

      yield* connection.client.subscribe("rooms.get", roomQuery(room.id, profileId)).pipe(
        // An ended room stays readable with the status `ended`; it never changes again.
        Stream.takeUntil((current) => current.clock.status === "ended"),
        Stream.mapEffect(snapshot),
        Stream.runForEach((next) =>
          output.out(invocation.format === "json" ? JSON.stringify(next.json) : `${next.human}\n`),
        ),
      );

      // JSON mode stays one line per change; the last line shows the room ended.
      if (invocation.format === "table") yield* output.out("The room ended.");

      return Outcome.Printed();
    }),
};

type NextCommand = "rooms.startNextCountdown" | "rooms.cancelNextCountdown" | "rooms.playNext";

/**
 * A host's next-episode command on the named room or the one this device is in, from the episode
 * the room plays as it reads it, so racing the countdown acts once.
 */
const nextControl = (path: string, name: NextCommand): ShortcutCommand => ({
  path,
  options: {},
  positionals: true,
  run: (invocation) =>
    Effect.gen(function* () {
      const connection = yield* connect(invocation.env, invocation.target, "required");
      const room = yield* resolveRoom(invocation, connection, connection.viewingProfileId);

      if (room.episode === null) {
        return yield* usage(invocation, `${path} needs a room playing an episode`);
      }

      const changed = yield* connection.withSession(
        connection.client.mutate(name, {
          roomId: room.id,
          deviceId: connection.deviceId,
          fromEpisodeId: room.episode.id,
        }),
      );

      return resultOutcome(commands[name], yield* encodeResult(name, commands[name], changed));
    }),
});

/** The room shortcuts. */
export const roomCommands: ReadonlyArray<ShortcutCommand> = [
  create,
  join,
  hostControl("rooms play", "rooms.play", false),
  hostControl("rooms pause", "rooms.pause", false),
  hostControl("rooms seek", "rooms.seek", true),
  nextControl("rooms next", "rooms.playNext"),
  nextControl("rooms countdown", "rooms.startNextCountdown"),
  nextControl("rooms cancel-countdown", "rooms.cancelNextCountdown"),
  leave,
  status,
];
