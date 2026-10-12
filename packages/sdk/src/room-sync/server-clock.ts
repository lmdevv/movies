/**
 * Reading the server clock to estimate how far this device's clock is from it, NTP style. The
 * engine keeps a window of recent readings and trusts the one with the shortest round trip
 * (`estimateClockOffset` in the contracts), assuming the server read its clock halfway through.
 */
import type { ClockSample } from "@movies/contracts/clock";
import { Clock, Effect, Option } from "effect";

import { MoviesClient } from "../movies-client";
import type { CallError } from "../sdk-errors";

/** One round trip to the server clock, timed with this device's clock. */
const sampleServerClock: Effect.Effect<ClockSample, CallError, MoviesClient> = Effect.gen(
  function* () {
    const client = yield* MoviesClient;
    const sentAt = yield* Clock.currentTimeMillis;
    const { serverTime } = yield* client.mutate("rooms.time", {});
    const receivedAt = yield* Clock.currentTimeMillis;

    return { sentAt, serverTime, receivedAt };
  },
);

/** Takes up to `count` readings `spacingMs` apart, skipping readings that failed. */
export const readServerClock = Effect.fn("ServerClock.read")(function* (
  count: number,
  spacingMs: number,
) {
  const readings = yield* Effect.forEach(
    Array.from({ length: Math.max(1, count) }, (_, index) => index),
    (index) => Effect.option(sampleServerClock).pipe(Effect.delay(index === 0 ? 0 : spacingMs)),
  );

  return readings.flatMap(Option.toArray);
});
