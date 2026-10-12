/**
 * Watch room shortcuts. The CLI has no player of its own, so host controls act on the room's live
 * position: `pause` freezes it where the room is now, `play` resumes from there or `--position`.
 * Each control reads the room first and sends its current revision; a revision that moved on in
 * between is read again and retried once.
 */
import { targetPosition } from "@movies/contracts/clock";
import { commands } from "@movies/contracts/commands";
import { NotFound } from "@movies/contracts/errors";
import { EpisodeId, RoomId } from "@movies/contracts/ids";
import type { Room, RoomClock } from "@movies/contracts/models/rooms";
import type { EpochMillis, Milliseconds } from "@movies/contracts/units";
import {
  EpochMillis as EpochMillisSchema,
  Milliseconds as MillisecondsSchema,
} from "@movies/contracts/units";
import { Clock, Effect, Option, Stream } from "effect";

import type { Invocation, ShortcutCommand } from "./invocation";
import {
  booleanFlag,
  encodeResult,
  positionalText,
  positionFlag,
  requirePositional,
  resultOutcome,
  stringFlag,
  textOutcome,
  usage,
  viewingProfile,
} from "./invocation";
import { Output } from "./output";
import { formatDuration } from "./render";
import type { Connection } from "./session";
import { connect } from "./session";
import { findTitle } from "./watch-commands";

/** The room named on the command line, or the one this device is in. */
const resolveRoom = Effect.fn("Rooms.resolve")(function* (
  invocation: Invocation,
  connection: Connection,
) {
  const named = positionalText(invocation.tokens);

  if (Option.isSome(named)) {
    return yield* connection.withSession(
      connection.client.query("rooms.get", { roomId: RoomId.make(named.value) }),
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

/** The server's clock: `rooms.time` when this session may play, else this machine's clock. */
const serverNow = (connection: Connection): Effect.Effect<EpochMillis> =>
  connection.client.mutate("rooms.time", {}).pipe(
    Effect.map(({ serverTime }) => serverTime),
    Effect.catch(() => Effect.map(Clock.currentTimeMillis, (now) => EpochMillisSchema.make(now))),
  );

const livePosition = (connection: Connection, clock: RoomClock): Effect.Effect<Milliseconds> =>
  Effect.map(serverNow(connection), (now) => targetPosition(clock, now));

type HostCommand = "rooms.play" | "rooms.pause" | "rooms.seek";

/** Sends a host control at the room's current revision, retrying once after a stale revision. */
const control = (
  invocation: Invocation,
  name: HostCommand,
  position: (connection: Connection, room: Room) => Effect.Effect<Milliseconds>,
) =>
  Effect.gen(function* () {
    const connection = yield* connect(invocation.env, invocation.target, "required");

    const send = Effect.gen(function* () {
      const room = yield* resolveRoom(invocation, connection);
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
          onNone: () => livePosition(connection, room.clock),
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
      const room = yield* resolveRoom(invocation, connection);

      yield* connection.withSession(
        connection.client.mutate("rooms.leave", { roomId: room.id, deviceId: connection.deviceId }),
      );

      return textOutcome({ ok: true, roomId: room.id }, `Left room ${room.id}.`);
    }),
};

const describeRoom = (room: Room, liveMs: number): string =>
  [
    `${room.title.name} · ${room.clock.status} at ${formatDuration(liveMs)} · revision ${String(room.clock.revision)}${room.hostAway ? " · host away" : ""}`,
    ...room.members.map(
      (member) =>
        `  ${member.role === "host" ? "host " : "guest"} ${member.profileName} (${member.deviceId})`,
    ),
  ].join("\n");

const status: ShortcutCommand = {
  path: "rooms status",
  options: { watch: { type: "boolean" } },
  positionals: true,
  run: (invocation) =>
    Effect.gen(function* () {
      const output = yield* Output;
      const connection = yield* connect(invocation.env, invocation.target, "required");
      const room = yield* resolveRoom(invocation, connection);
      const command = commands["rooms.get"];

      const snapshot = (current: Room) =>
        Effect.gen(function* () {
          const live = yield* livePosition(connection, current.clock);

          return {
            json: {
              room: yield* encodeResult("rooms.get", command, current),
              livePositionMs: live,
            },
            human: describeRoom(current, live),
          };
        });

      if (!booleanFlag(invocation.tokens, "watch")) return yield* snapshot(room);

      yield* connection.client.subscribe("rooms.get", { roomId: room.id }).pipe(
        Stream.mapEffect(snapshot),
        Stream.runForEach((next) =>
          output.out(invocation.format === "json" ? JSON.stringify(next.json) : `${next.human}\n`),
        ),
      );

      return textOutcome({ ok: true }, "The room ended.");
    }),
};

/** The room shortcuts. */
export const roomCommands: ReadonlyArray<ShortcutCommand> = [
  create,
  join,
  hostControl("rooms play", "rooms.play", false),
  hostControl("rooms pause", "rooms.pause", false),
  hostControl("rooms seek", "rooms.seek", true),
  leave,
  status,
];
