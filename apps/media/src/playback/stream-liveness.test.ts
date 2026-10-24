import { assert, describe, it } from "@effect/vitest";
import { Option, Schema } from "effect";

import {
  hear,
  holdsEncoder,
  isExpired,
  isUnattended,
  Liveness,
  PROGRESS_FRESH_MS,
  SessionReport,
  snapshot,
  type Use,
} from "./stream-liveness.ts";

const IDLE_MS = 60_000;

const NOW = 1_000_000_000;

const Heard = Schema.Struct({
  state: Schema.Literals(["playing", "paused", "ended"]),
  positionMs: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5 })),
  afterMs: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 60_000 })),
});

const reportOf = (heard: typeof Heard.Type): SessionReport =>
  heard.state === "ended"
    ? SessionReport.Ended()
    : SessionReport.Active({ state: heard.state, positionMs: heard.positionMs });

const quiet = (overrides: Partial<Use> = {}): Use => ({
  inFlight: 0,
  lastRequestAt: NOW - IDLE_MS,
  expiresAt: NOW + 3_600_000,
  ...overrides,
});

describe("hear", () => {
  it.prop(
    "changes nothing when a report arrives again, however late",
    { history: Schema.Array(Heard), again: Heard },
    ({ history, again }) => {
      let at = NOW;
      let known: Liveness = Liveness.Unknown();

      for (const heard of [...history, again]) {
        at += heard.afterMs;
        known = hear(known, reportOf(heard), at);
      }

      assert.strictEqual(hear(known, reportOf(again), at + again.afterMs + 1), known);
    },
  );

  it("counts progress only when the reported position moves", () => {
    const started = hear(
      Liveness.Unknown(),
      SessionReport.Active({ state: "playing", positionMs: 10_000 }),
      NOW,
    );

    const same = hear(
      started,
      SessionReport.Active({ state: "playing", positionMs: 10_000 }),
      NOW + 20_000,
    );

    const moved = hear(
      same,
      SessionReport.Active({ state: "playing", positionMs: 20_000 }),
      NOW + 30_000,
    );

    assert.deepStrictEqual(same, Liveness.Playing({ positionMs: 10_000, progressAt: NOW }));
    assert.deepStrictEqual(
      moved,
      Liveness.Playing({ positionMs: 20_000, progressAt: NOW + 30_000 }),
    );
  });

  it("counts a resume as progress and keeps the last progress through a pause and an end", () => {
    const playing = Liveness.Playing({ positionMs: 10_000, progressAt: NOW });

    const paused = hear(
      playing,
      SessionReport.Active({ state: "paused", positionMs: 10_000 }),
      NOW + 5_000,
    );

    const still = hear(
      paused,
      SessionReport.Active({ state: "paused", positionMs: 10_000 }),
      NOW + 9_000,
    );

    const resumed = hear(
      still,
      SessionReport.Active({ state: "playing", positionMs: 10_000 }),
      NOW + 70_000,
    );

    const ended = hear(paused, SessionReport.Ended(), NOW + 80_000);

    assert.deepStrictEqual(paused, Liveness.Paused({ progressAt: Option.some(NOW) }));
    assert.strictEqual(still, paused);
    assert.deepStrictEqual(
      resumed,
      Liveness.Playing({ positionMs: 10_000, progressAt: NOW + 70_000 }),
    );
    assert.deepStrictEqual(ended, Liveness.Ended({ progressAt: Option.some(NOW) }));
  });
});

describe("snapshot", () => {
  const playing = Liveness.Playing({ positionMs: 0, progressAt: NOW - 5_000 });

  it("ranks a request in flight over everything Convex says", () => {
    const moment = snapshot(
      quiet({ inFlight: 1, lastRequestAt: NOW - 600_000 }),
      Liveness.Ended({ progressAt: Option.none() }),
      NOW,
      IDLE_MS,
    );

    assert.strictEqual(moment.liveness, "requesting");
    assert.isTrue(holdsEncoder(moment));
  });

  it("holds an encoder for STREAM_IDLE_SECONDS after the last request, then lets it go", () => {
    const recent = snapshot(
      quiet({ lastRequestAt: NOW - IDLE_MS + 1 }),
      Liveness.Unknown(),
      NOW,
      IDLE_MS,
    );

    const idle = snapshot(quiet(), Liveness.Unknown(), NOW, IDLE_MS);

    assert.deepStrictEqual(recent, {
      liveness: "recent",
      inFlight: 0,
      lastRequestAgeMs: IDLE_MS - 1,
      lastProgressAgeMs: null,
    });
    assert.isTrue(holdsEncoder(recent));
    assert.strictEqual(idle.liveness, "unknown");
    assert.isFalse(holdsEncoder(idle));
  });

  it("holds a playing session's encoder however long since its last request", () => {
    const moment = snapshot(quiet({ lastRequestAt: NOW - 600_000 }), playing, NOW, IDLE_MS);

    assert.deepStrictEqual(moment, {
      liveness: "playing",
      inFlight: 0,
      lastRequestAgeMs: 600_000,
      lastProgressAgeMs: 5_000,
    });
    assert.isTrue(holdsEncoder(moment));
  });

  it("lets go of a session that says it plays but whose position stopped moving", () => {
    const stale = Liveness.Playing({ positionMs: 0, progressAt: NOW - PROGRESS_FRESH_MS });
    const moment = snapshot(quiet(), stale, NOW, IDLE_MS);

    assert.strictEqual(moment.liveness, "stale");
    assert.isFalse(holdsEncoder(moment));
  });

  it("lets go of paused and ended sessions, and says when they last made progress", () => {
    const paused = snapshot(
      quiet(),
      Liveness.Paused({ progressAt: Option.some(NOW - 40_000) }),
      NOW,
      IDLE_MS,
    );

    const ended = snapshot(quiet(), Liveness.Ended({ progressAt: Option.none() }), NOW, IDLE_MS);

    assert.deepStrictEqual([paused.liveness, paused.lastProgressAgeMs], ["paused", 40_000]);
    assert.deepStrictEqual([ended.liveness, ended.lastProgressAgeMs], ["ended", null]);
    assert.isFalse(holdsEncoder(paused) || holdsEncoder(ended));
  });
});

describe("isExpired", () => {
  it("expires a stream once nothing uses it and every token that reached it expired", () => {
    assert.isFalse(isExpired(quiet({ expiresAt: NOW + 1 }), NOW));
    assert.isTrue(isExpired(quiet({ expiresAt: NOW }), NOW));
    assert.isFalse(isExpired(quiet({ expiresAt: NOW - 1, inFlight: 1 }), NOW));
  });
});

describe("isUnattended", () => {
  const releasedAt = NOW - 10 * IDLE_MS;

  const released = (overrides: Partial<Use> = {}) =>
    quiet({ lastRequestAt: releasedAt - IDLE_MS, ...overrides });

  it("closes a released stream no report reached once nothing used it for ten idle periods", () => {
    assert.isTrue(isUnattended(released(), Liveness.Unknown(), releasedAt, NOW, IDLE_MS));
    assert.isFalse(isUnattended(released(), Liveness.Unknown(), releasedAt + 1, NOW, IDLE_MS));
  });

  it("counts from a request that came after the release", () => {
    const used = released({ lastRequestAt: releasedAt + IDLE_MS });

    assert.isFalse(isUnattended(used, Liveness.Unknown(), releasedAt, NOW, IDLE_MS));
    assert.isTrue(isUnattended(used, Liveness.Unknown(), releasedAt, NOW + IDLE_MS, IDLE_MS));
  });

  it("never closes a stream in use or one whose session reported", () => {
    assert.isFalse(
      isUnattended(released({ inFlight: 1 }), Liveness.Unknown(), releasedAt, NOW, IDLE_MS),
    );

    for (const [state, reported] of [
      ["paused", Liveness.Paused({ progressAt: Option.none() })],
      ["stale", Liveness.Playing({ positionMs: 0, progressAt: releasedAt })],
      ["ended", Liveness.Ended({ progressAt: Option.none() })],
    ] as const) {
      assert.isFalse(isUnattended(released(), reported, releasedAt, NOW, IDLE_MS), state);
    }
  });
});
