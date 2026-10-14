import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { estimateClockOffset, isNewerRevision, targetPosition, toServerTime } from "./clock";
import type { RoomClock } from "./models/rooms";
import { EpochMillis, Milliseconds } from "./units";

const ms = (value: number): Milliseconds => Milliseconds.make(value);

const at = (value: number): EpochMillis => EpochMillis.make(value);

const anchored = (status: RoomClock["status"], playbackRate: number): RoomClock => ({
  status,
  positionAtAnchorMs: ms(60_000),
  anchorServerTime: at(1_000_000),
  playbackRate,
  revision: 3,
});

const statuses = fc.constantFrom<RoomClock["status"]>("playing", "paused", "buffering", "ended");

const instants = fc.integer({ min: 0, max: 4_000_000_000_000 });

describe("targetPosition", () => {
  it("holds still unless playing", () => {
    fc.assert(
      fc.property(statuses, instants, (status, now) => {
        fc.pre(status !== "playing");

        expect(targetPosition(anchored(status, 1), at(now))).toBe(60_000);
      }),
    );
  });

  it("advances from the anchor at the playback rate", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 86_400_000 }),
        fc.double({ min: 0.5, max: 2, noNaN: true }),
        (elapsed, rate) => {
          const playing = anchored("playing", rate);
          const target = targetPosition(playing, at(playing.anchorServerTime + elapsed));

          expect(target).toBeCloseTo(60_000 + elapsed * rate, 6);
        },
      ),
    );
  });

  it("never moves backwards when the server reading predates the anchor", () => {
    expect(targetPosition(anchored("playing", 1), at(500_000))).toBe(60_000);
  });
});

describe("isNewerRevision", () => {
  it("accepts the first clock and only higher revisions after it", () => {
    expect(isNewerRevision({ revision: 0 }, undefined)).toBe(true);
    expect(isNewerRevision({ revision: 4 }, { revision: 3 })).toBe(true);
    expect(isNewerRevision({ revision: 3 }, { revision: 3 })).toBe(false);
    expect(isNewerRevision({ revision: 2 }, { revision: 3 })).toBe(false);
  });
});

describe("estimateClockOffset", () => {
  it("returns nothing without samples", () => {
    expect(estimateClockOffset([])).toBeUndefined();
  });

  it("recovers the true offset from a symmetric round trip", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -3_600_000, max: 3_600_000 }),
        fc.integer({ min: 0, max: 2_000 }),
        (offset, oneWay) => {
          const sentAt = 5_000_000;

          const estimate = estimateClockOffset([
            { sentAt, serverTime: at(sentAt + oneWay + offset), receivedAt: sentAt + 2 * oneWay },
          ]);

          expect(estimate).toStrictEqual({ offsetMs: offset, roundTripMs: 2 * oneWay });
        },
      ),
    );
  });

  it("trusts the sample with the shortest round trip", () => {
    const estimate = estimateClockOffset([
      { sentAt: 0, serverTime: at(10_400), receivedAt: 800 },
      { sentAt: 1_000, serverTime: at(11_050), receivedAt: 1_100 },
    ]);

    expect(estimate).toStrictEqual({ offsetMs: 10_000, roundTripMs: 100 });
    expect(toServerTime(2_000, { offsetMs: 10_000.5, roundTripMs: 100 })).toBe(12_001);
  });

  it("ignores a sample whose client clock stepped back during the round trip", () => {
    const estimate = estimateClockOffset([
      { sentAt: 5_000, serverTime: at(15_050), receivedAt: 3_000 },
      { sentAt: 1_000, serverTime: at(11_050), receivedAt: 1_100 },
    ]);

    expect(estimate).toStrictEqual({ offsetMs: 10_000, roundTripMs: 100 });
    expect(
      estimateClockOffset([{ sentAt: 5_000, serverTime: at(15_050), receivedAt: 3_000 }]),
    ).toBeUndefined();
  });
});
