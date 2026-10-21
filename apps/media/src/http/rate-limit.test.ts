import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";

import { makeLimiter } from "./rate-limit.ts";

const budget = { burst: 3, perSecond: 2 };

describe("rate limit", () => {
  it("allows a burst, refuses beyond it, and refills over time", () => {
    const take = makeLimiter();

    assert.deepStrictEqual(
      [0, 0, 0].map((now) => Option.isNone(take([["a", budget]], now))),
      [true, true, true],
    );
    assert.deepStrictEqual(take([["a", budget]], 0), Option.some(1));

    // Another address has its own bucket.
    assert.isTrue(Option.isNone(take([["b", budget]], 0)));

    // Half a second refills one token at two per second.
    assert.isTrue(Option.isNone(take([["a", budget]], 500)));
    assert.isTrue(Option.isSome(take([["a", budget]], 500)));

    // A long pause refills to the burst, never beyond.
    const after = [60_000, 60_000, 60_000, 60_000].map((now) =>
      Option.isNone(take([["a", budget]], now)),
    );

    assert.deepStrictEqual(after, [true, true, true, false]);
  });

  it("forgets the least recently used address when full, never a busy one", () => {
    const take = makeLimiter(3);

    // "busy" spends its burst, then many new addresses arrive while it stays active.
    for (let index = 0; index < 3; index += 1) take([["busy", budget]], 0);

    for (let index = 0; index < 100; index += 1) {
      take([[`new-${index}`, budget]], 0);
      assert.isTrue(Option.isSome(take([["busy", budget]], 0)));
    }
  });

  it("takes from every bucket or from none", () => {
    const take = makeLimiter();
    const roomy = { burst: 10, perSecond: 1 };

    // The second bucket is spent: the first must keep its tokens.
    for (let index = 0; index < 3; index += 1) take([["account", budget]], 0);

    assert.isTrue(
      Option.isSome(
        take(
          [
            ["session", roomy],
            ["account", budget],
          ],
          0,
          5,
        ),
      ),
    );
    assert.isTrue(Option.isNone(take([["session", roomy]], 0, 10)));
  });
});
