import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { believedPosition, placed, reported } from "./playhead";

const REPORT_MS = 250;

describe("reported", () => {
  it("believes a player that plays on at its rate", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.constantFrom(0.5, 1, 1.5, 2),
        fc.integer({ min: 1, max: 400 }),
        (startMs, rate, reports) => {
          let playhead = placed(startMs, 0);

          for (let report = 1; report <= reports; report += 1) {
            playhead = reported(
              playhead,
              startMs + report * REPORT_MS * rate,
              report * REPORT_MS,
              rate,
            );
          }

          return playhead.believed.positionMs === startMs + reports * REPORT_MS * rate;
        },
      ),
    );
  });

  it("never believes a player stuck somewhere it could not have played to", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 60_000, max: 10_000_000 }),
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.integer({ min: 1, max: 2_000 }),
        (believedMs, stuckMs, reports) => {
          fc.pre(Math.abs(stuckMs - believedMs) > 20_000);
          let playhead = placed(believedMs, 0);

          for (let report = 1; report <= reports; report += 1) {
            playhead = reported(playhead, stuckMs, report * REPORT_MS, 1);
          }

          return (
            playhead.believed.positionMs === believedMs &&
            believedPosition(playhead, stuckMs, reports * REPORT_MS, 1) === believedMs
          );
        },
      ),
    );
  });

  it("never believes a player skipping ahead faster than it plays", () => {
    let playhead = placed(2_160_000, 0);

    // Each failed segment moves AVPlayer six seconds on in a few milliseconds.
    for (let segment = 1; segment <= 100; segment += 1) {
      playhead = reported(playhead, 2_160_000 + segment * 6_000, segment * 10, 1);
    }

    expect(playhead.believed.positionMs).toBe(2_160_000);
  });

  it("believes a jump once the player plays on from it for a few seconds", () => {
    let playhead = reported(placed(600_000, 0), 1_500_000, REPORT_MS, 1);

    expect(playhead.believed.positionMs).toBe(600_000);

    for (let report = 1; report <= 12; report += 1) {
      playhead = reported(
        playhead,
        1_500_000 + report * REPORT_MS,
        REPORT_MS + report * REPORT_MS,
        1,
      );
    }

    expect(playhead.believed.positionMs).toBe(1_503_000);
  });
});
