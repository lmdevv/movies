import type { ClockAnchor } from "@movies/contracts/clock";
import { targetPosition } from "@movies/contracts/clock";
import { EpochMillis, Milliseconds } from "@movies/contracts/units";
import { Option } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { PlayerSnapshot } from "./sync-policy";
import { DEFAULT_TUNABLES, follow, hostIntent, PlayerCommand } from "./sync-policy";

const NOW = EpochMillis.make(1_760_000_000_000);

const clocks = fc.record({
  status: fc.constantFrom<ClockAnchor["status"]>("playing", "paused", "buffering", "ended"),
  positionAtAnchorMs: fc.integer({ min: 0, max: 10_000_000 }).map((ms) => Milliseconds.make(ms)),
  anchorServerTime: fc.integer({ min: 0, max: 600_000 }).map((ago) => EpochMillis.make(NOW - ago)),
  playbackRate: fc.constantFrom(0.5, 1, 1.25, 2),
});

const playing = clocks.map((clock): ClockAnchor => ({ ...clock, status: "playing" }));

const stopped = clocks.filter((clock) => clock.status !== "playing");

const players = fc.record({
  positionMs: fc.integer({ min: 0, max: 20_000_000 }),
  paused: fc.boolean(),
  buffering: fc.boolean(),
  playbackRate: fc.constantFrom(0.95, 1, 1.05, 2),
  fixedRate: fc.constant(false),
});

const isSeek = PlayerCommand.$is("Seek");

const at = (clock: ClockAnchor, offsetMs: number, paused: boolean): PlayerSnapshot => ({
  positionMs: targetPosition(clock, NOW) + offsetMs,
  paused,
  buffering: false,
  playbackRate: clock.playbackRate,
  fixedRate: false,
});

describe("follow", () => {
  it("leaves an in-sync player at the room's rate alone", () => {
    fc.assert(
      fc.property(playing, fc.integer({ min: -100, max: 100 }), (clock, offset) => {
        expect(follow(clock, NOW, at(clock, offset, false), false, DEFAULT_TUNABLES)).toStrictEqual(
          { commands: [], driftMs: offset },
        );
      }),
    );
  });

  it("seeks only beyond the seek threshold and never during the cooldown", () => {
    fc.assert(
      fc.property(playing, players, fc.boolean(), (clock, player, recentlySought) => {
        const decision = follow(clock, NOW, player, recentlySought, DEFAULT_TUNABLES);
        const distance = Math.abs(player.positionMs - targetPosition(clock, NOW));

        if (decision.commands.some(isSeek)) {
          expect(recentlySought).toBe(false);
          expect(distance).toBeGreaterThanOrEqual(DEFAULT_TUNABLES.seekMs);
        }
      }),
    );
  });

  it("seeks a player that cannot change its rate past its own threshold, and never nudges it", () => {
    fc.assert(
      fc.property(
        playing,
        fc.integer({ min: -5_000, max: 5_000 }),
        fc.boolean(),
        (clock, offset, recentlySought) => {
          const cast = { ...at(clock, offset, false), playbackRate: 1, fixedRate: true };
          const { commands } = follow(clock, NOW, cast, recentlySought, DEFAULT_TUNABLES);
          const far = Math.abs(offset) >= DEFAULT_TUNABLES.fixedRateSeekMs;

          expect(commands.some(PlayerCommand.$is("SetRate"))).toBe(false);
          expect(commands.some(isSeek)).toBe(far && !recentlySought);
        },
      ),
    );
  });

  it("waits out a stall in a playing room", () => {
    fc.assert(
      fc.property(playing, players, (clock, player) => {
        expect(
          follow(clock, NOW, { ...player, buffering: true }, false, DEFAULT_TUNABLES),
        ).toStrictEqual({ commands: [], driftMs: null });
      }),
    );
  });

  it("nudges toward the shared position between the thresholds", () => {
    fc.assert(
      fc.property(
        playing,
        fc.integer({ min: 200, max: 1_400 }),
        fc.boolean(),
        (clock, gap, ahead) => {
          const decision = follow(
            clock,
            NOW,
            at(clock, ahead ? gap : -gap, false),
            false,
            DEFAULT_TUNABLES,
          );

          const [command] = decision.commands;

          expect(decision.commands).toHaveLength(1);
          expect(command !== undefined && PlayerCommand.$is("SetRate")(command)).toBe(true);

          if (command !== undefined && PlayerCommand.$is("SetRate")(command)) {
            expect(
              ahead ? command.rate < clock.playbackRate : command.rate > clock.playbackRate,
            ).toBe(true);
          }
        },
      ),
    );
  });

  it("holds a stopped room's player paused at the anchor", () => {
    fc.assert(
      fc.property(stopped, players, (clock, player) => {
        const { commands } = follow(clock, NOW, player, true, DEFAULT_TUNABLES);

        expect(commands.some(PlayerCommand.$is("Play"))).toBe(false);
        expect(commands.some(PlayerCommand.$is("Pause"))).toBe(!player.paused);

        const far =
          Math.abs(player.positionMs - clock.positionAtAnchorMs) > DEFAULT_TUNABLES.inSyncMs;

        expect(commands.some(isSeek)).toBe(far);
      }),
    );
  });
});

describe("hostIntent", () => {
  it("asks for nothing when the host's player matches the committed clock", () => {
    fc.assert(
      fc.property(
        clocks.filter((clock) => clock.status !== "buffering"),
        fc.integer({ min: -500, max: 500 }),
        fc.boolean(),
        (clock, offset, seeked) => {
          const player = at(clock, offset, clock.status !== "playing");

          expect(hostIntent(clock, NOW, player, seeked, DEFAULT_TUNABLES)).toStrictEqual(
            Option.none(),
          );
        },
      ),
    );
  });

  it("turns state differences into the matching room command", () => {
    const clock: ClockAnchor = {
      status: "paused",
      positionAtAnchorMs: Milliseconds.make(5_000),
      anchorServerTime: NOW,
      playbackRate: 1,
    };

    const intent = (player: PlayerSnapshot, seeked: boolean, anchor = clock) =>
      Option.map(
        hostIntent(anchor, NOW, player, seeked, DEFAULT_TUNABLES),
        (found) => found.command,
      );

    expect(intent(at(clock, 0, false), false)).toStrictEqual(Option.some("rooms.play"));
    expect(intent(at(clock, 60_000, true), true)).toStrictEqual(Option.some("rooms.seek"));
    expect(intent(at(clock, 60_000, true), false)).toStrictEqual(Option.none());

    const live: ClockAnchor = { ...clock, status: "playing" };

    expect(intent(at(live, 0, true), false, live)).toStrictEqual(Option.some("rooms.pause"));
    expect(intent({ ...at(live, 0, false), buffering: true }, false, live)).toStrictEqual(
      Option.some("rooms.buffering"),
    );
    expect(intent(at(live, 0, false), false, { ...live, status: "ended" })).toStrictEqual(
      Option.none(),
    );
  });
});
