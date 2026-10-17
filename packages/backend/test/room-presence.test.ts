import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { ClockAnchor } from "../convex/lib/roomClock";
import {
  awayHostClock,
  HOST_ABANDON_TIMEOUT_MS,
  isAbandoned,
  livePosition,
} from "../convex/lib/roomClock";

const NOW = 1_760_000_000_000;

const FILM_MS = 6_000_000;

const anchor = (change: Partial<ClockAnchor>): ClockAnchor => ({
  status: "playing",
  positionAtAnchorMs: 60_000,
  anchorServerTime: NOW - 10_000,
  playbackRate: 1,
  ...change,
});

const clocks = fc.record({
  status: fc.constantFrom("playing", "paused", "buffering", "ended"),
  positionAtAnchorMs: fc.double({ min: 0, max: 2 * FILM_MS, noNaN: true }),
  anchorServerTime: fc.integer({ min: NOW - 3_600_000, max: NOW }),
  playbackRate: fc.constantFrom(0.5, 1, 1.5, 2),
});

describe("awayHostClock", () => {
  it("keeps a playing room playing while the host browses", () => {
    expect(awayHostClock(anchor({}), FILM_MS, NOW)).toBeNull();
  });

  it("pauses a room frozen for the host's buffering where it froze", () => {
    expect(awayHostClock(anchor({ status: "buffering" }), FILM_MS, NOW)).toStrictEqual({
      status: "paused",
      positionAtAnchorMs: 60_000,
      anchorServerTime: NOW,
    });
  });

  it("pauses a room that played past the end of its file at the end", () => {
    const late = anchor({ positionAtAnchorMs: FILM_MS - 1_000 });

    expect(awayHostClock(late, FILM_MS, NOW)).toStrictEqual({
      status: "paused",
      positionAtAnchorMs: FILM_MS,
      anchorServerTime: NOW,
    });
  });

  it("never ends a file whose length is unknown", () => {
    expect(awayHostClock(anchor({}), 0, NOW)).toBeNull();
    expect(awayHostClock(anchor({}), Number.NaN, NOW)).toBeNull();
  });

  it("changes only a frozen room, where it froze, or one past the end, at the end", () => {
    fc.assert(
      fc.property(clocks, (clock) => {
        const paused = awayHostClock(clock, FILM_MS, NOW);

        if (paused === null) {
          expect(clock.status === "buffering").toBe(false);
          expect(clock.status !== "playing" || livePosition(clock, NOW) < FILM_MS).toBe(true);

          return;
        }

        expect(paused.anchorServerTime).toBe(NOW);
        expect(paused.positionAtAnchorMs).toBe(
          clock.status === "buffering" ? clock.positionAtAnchorMs : FILM_MS,
        );
        expect(paused.positionAtAnchorMs).toBeLessThanOrEqual(livePosition(clock, NOW));
      }),
    );
  });
});

describe("isAbandoned", () => {
  const present = { hostLastSeenAt: NOW - 5_000 };
  const longAgo = NOW - HOST_ABANDON_TIMEOUT_MS - 1;

  it("keeps a room someone played within the timeout", () => {
    expect(
      isAbandoned(
        present,
        [
          { lastSeenAt: NOW, watchedAt: longAgo },
          { lastSeenAt: NOW, watchedAt: NOW - 60_000 },
        ],
        NOW,
      ),
    ).toBe(false);
  });

  it("ends a room everyone left to browse, though the host is present", () => {
    expect(isAbandoned(present, [{ lastSeenAt: NOW, watchedAt: longAgo }], NOW)).toBe(true);
  });

  it("counts any heartbeat on rows from before players reported, and ends a silent host's room", () => {
    expect(isAbandoned(present, [{ lastSeenAt: NOW - 60_000 }], NOW)).toBe(false);
    expect(isAbandoned(present, [{ lastSeenAt: longAgo }], NOW)).toBe(true);
    expect(
      isAbandoned({ hostLastSeenAt: longAgo }, [{ lastSeenAt: NOW, watchedAt: NOW }], NOW),
    ).toBe(true);
  });
});
