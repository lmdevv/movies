import { targetPosition } from "@movies/contracts/clock";
import { DeviceId } from "@movies/contracts/ids";
import type { RoomClock } from "@movies/contracts/models/rooms";
import { Room, RoomClock as RoomClockSchema } from "@movies/contracts/models/rooms";
import { EpochMillis, Milliseconds } from "@movies/contracts/units";
import { Deferred, Effect, Fiber, Layer, Option, Schema } from "effect";
import type { Scope } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import * as Movies from "../movies";
import type * as MoviesClient from "../movies-client";
import type { CallError } from "../sdk-errors";
import { clientLayer } from "../testing/client-context";
import * as FakeConvex from "../testing/fake-convex";
import { Reply } from "../testing/fake-convex";
import type { FakePlayer } from "../testing/fake-player";
import { makeFakePlayer } from "../testing/fake-player";
import type { MemoryRooms } from "../testing/memory-rooms";
import { makeMemoryRooms } from "../testing/memory-rooms";
import type { RoomSync } from "./room-sync";
import { hostControlsEnabled, run } from "./room-sync";
import { DEFAULT_TUNABLES } from "./sync-policy";
import * as TokenStorage from "../token-storage";

const START = 1_760_000_000_000;

/** The server's clock runs this far ahead of the devices'. */
const SERVER_OFFSET_MS = 7_000;

const LATENCY_MS = 40;

const HOST = DeviceId.make("host-device");

const GUEST = DeviceId.make("guest-device");

const decodeRoom = Schema.decodeUnknownSync(Room);

const roomWith = (clock: Partial<RoomClock>): Room =>
  decodeRoom({
    id: "room-1",
    title: {
      id: "title-1",
      kind: "movie",
      name: "Fixture",
      year: 2024,
      certification: null,
      ageRating: null,
      runtimeMs: 7_200_000,
      genres: [],
      artwork: { poster: null, backdrop: null, logo: null },
      available: true,
      addedAt: START,
    },
    episode: null,
    fileId: "file-1",
    hostUserId: "user-1",
    hostProfileId: "profile-1",
    hostDeviceId: HOST,
    hostProfileName: "Alex",
    hostAway: false,
    clock: {
      status: "paused",
      positionAtAnchorMs: 0,
      anchorServerTime: START + SERVER_OFFSET_MS,
      playbackRate: 1,
      revision: 0,
      ...clock,
    },
    members: [
      {
        userId: "user-2",
        profileId: "profile-2",
        profileName: "Maya",
        avatar: "blue",
        deviceId: GUEST,
        role: "guest",
        joinedAt: START,
        lastSeenAt: START,
        driftMs: null,
      },
    ],
    createdAt: START,
  });

/** Advances the test clock in small steps so every fiber gets to run. */
const advance = (ms: number) =>
  Effect.gen(function* () {
    for (let elapsed = 0; elapsed < ms; elapsed += 20) yield* TestClock.adjust(20);
  });

/** Where the room's shared timeline is now. */
const sharedPosition = (rooms: MemoryRooms) =>
  Effect.gen(function* () {
    const room = yield* rooms.room;
    const now = yield* rooms.serverNow;

    return targetPosition(room.clock, now);
  });

const driftOf = (rooms: MemoryRooms, player: FakePlayer) =>
  Effect.map(sharedPosition(rooms), (target) => player.positionMs() - target);

const start = (rooms: MemoryRooms, deviceId: DeviceId, player: FakePlayer) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(
      run({ roomId: (yield* rooms.room).id, deviceId, player, tunables: DEFAULT_TUNABLES }),
    );

    yield* advance(1_000);

    return yield* Fiber.join(fiber);
  });

const current = (sync: RoomSync) => sync.current;

interface Fixture {
  readonly rooms: MemoryRooms;
}

/** Runs a scenario against a fresh backend on the test clock. */
const scenario = (
  clock: Partial<RoomClock>,
  body: (
    fixture: Fixture,
  ) => Effect.Effect<void, CallError, MoviesClient.MoviesClient | Scope.Scope>,
): Promise<void> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const testClock = yield* Layer.build(TestClock.layer());

        yield* Effect.gen(function* () {
          yield* TestClock.setTime(START);

          const rooms = yield* makeMemoryRooms(roomWith(clock), {
            serverOffsetMs: SERVER_OFFSET_MS,
            latencyMs: LATENCY_MS,
          });

          const client = yield* Layer.build(clientLayer(rooms.transport));

          yield* body({ rooms }).pipe(Effect.provideContext(client));
        }).pipe(Effect.provideContext(testClock));
      }),
    ),
  );

/** A room that has been playing for a minute from position zero. */
const playingForAMinute: Partial<RoomClock> = {
  status: "playing",
  positionAtAnchorMs: Milliseconds.make(0),
  anchorServerTime: EpochMillis.make(START + SERVER_OFFSET_MS - 60_000),
  revision: 4,
};

describe("room sync", () => {
  it("estimates the server clock offset from the best round trip", () =>
    scenario({}, ({ rooms }) =>
      Effect.gen(function* () {
        const player = yield* makeFakePlayer(0);
        const sync = yield* start(rooms, GUEST, player);
        const { offset } = yield* current(sync);

        expect(offset?.offsetMs).toBeCloseTo(SERVER_OFFSET_MS, 0);
        expect(offset?.roundTripMs).toBe(2 * LATENCY_MS);
      }),
    ));

  it("seeks a late joiner straight to the live position and keeps it in sync", () =>
    scenario(playingForAMinute, ({ rooms }) =>
      Effect.gen(function* () {
        const player = yield* makeFakePlayer(0);
        const sync = yield* start(rooms, GUEST, player);

        expect(player.isPaused()).toBe(false);
        expect(Math.abs(yield* driftOf(rooms, player))).toBeLessThanOrEqual(
          DEFAULT_TUNABLES.inSyncMs,
        );

        yield* advance(30_000);
        expect(Math.abs(yield* driftOf(rooms, player))).toBeLessThanOrEqual(
          DEFAULT_TUNABLES.inSyncMs,
        );
        expect((yield* current(sync)).follow).toBe("following");
      }),
    ));

  it("reports a following guest's drift with its heartbeats", () =>
    scenario(playingForAMinute, ({ rooms }) =>
      Effect.gen(function* () {
        const player = yield* makeFakePlayer(0);

        yield* start(rooms, GUEST, player);
        yield* advance(DEFAULT_TUNABLES.heartbeatIntervalMs + 1_000);

        const reported = (yield* rooms.room).members.find((member) => member.deviceId === GUEST);

        expect(reported?.driftMs).toBeTypeOf("number");
        expect(Math.abs(reported?.driftMs ?? Infinity)).toBeLessThanOrEqual(
          DEFAULT_TUNABLES.inSyncMs,
        );
      }),
    ));

  it("nudges the rate for moderate drift instead of seeking", () =>
    scenario(playingForAMinute, ({ rooms }) =>
      Effect.gen(function* () {
        const player = yield* makeFakePlayer(0);

        yield* start(rooms, GUEST, player);
        yield* advance(4_000);

        // Fall 600 ms behind without a seek event, as a slow decoder would.
        player.setPlaybackRate(1);
        player.userSeek(player.positionMs() - 600);
        yield* advance(DEFAULT_TUNABLES.correctionIntervalMs + 100);

        expect(player.playbackRate()).toBeGreaterThan(1);
        yield* advance(20_000);
        expect(Math.abs(yield* driftOf(rooms, player))).toBeLessThanOrEqual(
          DEFAULT_TUNABLES.inSyncMs,
        );
        expect(player.playbackRate()).toBe(1);
      }),
    ));

  it("publishes host play, pause, and seek, and guests follow each", () =>
    scenario({}, ({ rooms }) =>
      Effect.gen(function* () {
        const host = yield* makeFakePlayer(0);
        const guest = yield* makeFakePlayer(0);
        const hostSync = yield* start(rooms, HOST, host);

        yield* start(rooms, GUEST, guest);
        expect(hostControlsEnabled(yield* current(hostSync))).toBe(true);

        host.userPlay();
        yield* advance(2_000);
        expect((yield* rooms.room).clock.status).toBe("playing");
        expect(guest.isPaused()).toBe(false);
        expect(Math.abs(yield* driftOf(rooms, guest))).toBeLessThanOrEqual(120);

        host.userPause();
        yield* advance(1_000);
        expect((yield* rooms.room).clock.status).toBe("paused");
        expect(guest.isPaused()).toBe(true);
        expect(Math.abs(guest.positionMs() - host.positionMs())).toBeLessThanOrEqual(120);

        host.userSeek(600_000);
        yield* advance(1_000);
        expect((yield* rooms.room).clock).toMatchObject({
          status: "paused",
          positionAtAnchorMs: 600_000,
        });
        expect(guest.positionMs()).toBe(600_000);

        host.userPlay();
        yield* advance(10_000);
        expect(Math.abs(yield* driftOf(rooms, guest))).toBeLessThanOrEqual(120);
        expect(Math.abs(yield* driftOf(rooms, host))).toBeLessThanOrEqual(120);
      }),
    ));

  it("lets a stalled guest buffer locally, then catch up", () =>
    scenario(playingForAMinute, ({ rooms }) =>
      Effect.gen(function* () {
        const guest = yield* makeFakePlayer(0);
        const sync = yield* start(rooms, GUEST, guest);

        guest.stall();
        yield* advance(3_000);
        expect((yield* current(sync)).follow).toBe("buffering");
        expect(yield* driftOf(rooms, guest)).toBeLessThan(-2_500);
        expect((yield* rooms.room).clock.status).toBe("playing");

        guest.recover();
        yield* advance(1_000);
        expect((yield* current(sync)).follow).toBe("following");
        expect(Math.abs(yield* driftOf(rooms, guest))).toBeLessThanOrEqual(120);
      }),
    ));

  it("freezes the room while the host buffers and resumes from its position", () =>
    scenario({}, ({ rooms }) =>
      Effect.gen(function* () {
        const host = yield* makeFakePlayer(0);
        const guest = yield* makeFakePlayer(0);

        yield* start(rooms, HOST, host);
        yield* start(rooms, GUEST, guest);
        host.userPlay();
        yield* advance(5_000);

        host.stall();
        yield* advance(1_000);
        expect((yield* rooms.room).clock.status).toBe("buffering");
        expect(guest.isPaused()).toBe(true);
        const frozen = host.positionMs();

        yield* advance(4_000);
        expect(Math.abs(guest.positionMs() - frozen)).toBeLessThanOrEqual(120);

        host.recover();
        yield* advance(1_000);
        expect((yield* rooms.room).clock).toMatchObject({ status: "playing" });
        expect(Math.abs((yield* rooms.room).clock.positionAtAnchorMs - frozen)).toBeLessThan(200);
        expect(guest.isPaused()).toBe(false);

        yield* advance(5_000);
        expect(Math.abs(yield* driftOf(rooms, guest))).toBeLessThanOrEqual(120);
      }),
    ));

  it("reverts the host to the committed clock when its command is stale", () =>
    scenario(playingForAMinute, ({ rooms }) =>
      Effect.gen(function* () {
        const host = yield* makeFakePlayer(60_000);

        host.userPlay();
        yield* start(rooms, HOST, host);
        yield* advance(2_000);

        // Another writer moved the room to 10 minutes without this device seeing it yet.
        yield* rooms.changeSilently({
          positionAtAnchorMs: Milliseconds.make(600_000),
          anchorServerTime: yield* rooms.serverNow,
        });

        host.userPause();
        yield* advance(1_000);

        const committed = yield* rooms.room;

        expect(committed.clock.status).toBe("playing");
        expect(host.isPaused()).toBe(false);
        expect(Math.abs(yield* driftOf(rooms, host))).toBeLessThanOrEqual(120);
      }),
    ));

  it("disables host controls while disconnected and reconciles on reconnect", () =>
    scenario({}, ({ rooms }) =>
      Effect.gen(function* () {
        const host = yield* makeFakePlayer(0);
        const guest = yield* makeFakePlayer(0);
        const hostSync = yield* start(rooms, HOST, host);
        const guestSync = yield* start(rooms, GUEST, guest);

        host.userPlay();
        yield* advance(2_000);

        yield* rooms.setConnected(false);
        yield* advance(DEFAULT_TUNABLES.heartbeatIntervalMs + 1_000);
        expect((yield* current(hostSync)).connection).toBe("reconnecting");
        expect(hostControlsEnabled(yield* current(hostSync))).toBe(false);

        // Offline, the guest keeps interpolating the last clock.
        expect(Math.abs(yield* driftOf(rooms, guest))).toBeLessThanOrEqual(120);

        // A pause while offline cannot reach the room.
        host.userPause();
        yield* advance(1_000);
        expect((yield* rooms.room).clock.status).toBe("playing");

        yield* rooms.setConnected(true);
        yield* advance(DEFAULT_TUNABLES.heartbeatIntervalMs + 2_000);
        expect((yield* current(hostSync)).connection).toBe("connected");
        expect((yield* current(guestSync)).connection).toBe("connected");
        expect(host.isPaused()).toBe(false);
        expect(Math.abs(yield* driftOf(rooms, host))).toBeLessThanOrEqual(120);
        expect(Math.abs(yield* driftOf(rooms, guest))).toBeLessThanOrEqual(120);
      }),
    ));

  it("leaves a guest who paused their own player alone until they play again", () =>
    scenario(playingForAMinute, ({ rooms }) =>
      Effect.gen(function* () {
        const guest = yield* makeFakePlayer(0);
        const sync = yield* start(rooms, GUEST, guest);

        guest.userPause();
        yield* advance(5_000);
        expect((yield* current(sync)).follow).toBe("detached");
        expect(guest.isPaused()).toBe(true);
        expect((yield* rooms.room).clock.status).toBe("playing");

        guest.userPlay();
        yield* advance(1_000);
        expect((yield* current(sync)).follow).toBe("following");
        expect(Math.abs(yield* driftOf(rooms, guest))).toBeLessThanOrEqual(120);
      }),
    ));

  it("waits for a user gesture when the platform blocks autoplay", () =>
    scenario(playingForAMinute, ({ rooms }) =>
      Effect.gen(function* () {
        const guest = yield* makeFakePlayer(0);

        guest.blockAutoplay(true);
        const sync = yield* start(rooms, GUEST, guest);

        expect((yield* current(sync)).follow).toBe("blocked");
        expect(guest.isPaused()).toBe(true);

        guest.userPlay();
        yield* advance(1_000);
        expect((yield* current(sync)).follow).toBe("following");

        // Less than a seek's worth behind: the rate nudge closes the gap.
        yield* advance(25_000);
        expect(Math.abs(yield* driftOf(rooms, guest))).toBeLessThanOrEqual(120);
      }),
    ));

  it("never sends host commands for a guest's player", () =>
    scenario(playingForAMinute, ({ rooms }) =>
      Effect.gen(function* () {
        const guest = yield* makeFakePlayer(0);

        yield* start(rooms, GUEST, guest);
        guest.userPause();
        guest.userSeek(10_000);
        guest.userPlay();
        guest.stall();
        guest.recover();
        yield* advance(3_000);

        const controls = (yield* rooms.calls).filter((path) =>
          ["rooms:play", "rooms:pause", "rooms:seek", "rooms:buffering"].includes(path),
        );

        expect(controls).toStrictEqual([]);
        expect((yield* rooms.room).clock.revision).toBe(4);
      }),
    ));
});

describe("room sync over HTTP", () => {
  const encodeRoom = Schema.encodeSync(Schema.toCodecJson(Room));

  const encodeClock = Schema.encodeSync(Schema.toCodecJson(RoomClockSchema));

  it("sends a heartbeat that waited on a host command with the command's revision", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fake = yield* FakeConvex.make;
          const room = roomWith({});
          const playArrived = yield* Deferred.make<void>();
          const releasePlay = yield* Deferred.make<void>();

          const playing = encodeClock(
            roomWith({
              status: "playing",
              anchorServerTime: EpochMillis.make(Date.now()),
              revision: 1,
            }).clock,
          );

          yield* fake.reply("rooms:get", Reply.Success({ value: encodeRoom(room) }));
          yield* fake.handle("rooms:time", () =>
            Effect.sync(() => Reply.Success({ value: { serverTime: Date.now() } })),
          );
          yield* fake.reply("rooms:heartbeat", Reply.Success({ value: playing }));
          yield* fake.handle("rooms:play", () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(playArrived, undefined);
              yield* Deferred.await(releasePlay);

              return Reply.Success({ value: playing });
            }),
          );

          const sdk = yield* Layer.build(
            Movies.layer({ convexUrl: fake.url, mediaUrl: Option.none(), connection: "http" }).pipe(
              Layer.provide(TokenStorage.layerMemory),
            ),
          );

          yield* Effect.gen(function* () {
            const host = yield* makeFakePlayer(0);

            yield* run({
              roomId: room.id,
              deviceId: HOST,
              player: host,
              tunables: { ...DEFAULT_TUNABLES, offsetSamples: 1, heartbeatIntervalMs: 20 },
            });

            host.userPlay();
            yield* Deferred.await(playArrived);
            // Heartbeats fall due while the play command holds the engine.
            yield* Effect.sleep(100);
            yield* Deferred.succeed(releasePlay, undefined);
            yield* Effect.sleep(100);
          }).pipe(Effect.provideContext(sdk));

          const requests = yield* fake.requests;
          const played = requests.findIndex((request) => request.path === "rooms:play");

          const waited = requests
            .slice(played + 1)
            .find((request) => request.path === "rooms:heartbeat");

          expect(played).toBeGreaterThanOrEqual(0);
          expect(waited?.args).toMatchObject({ deviceId: HOST, revision: 1 });
        }),
      ),
    ));
});
