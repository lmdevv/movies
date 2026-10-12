import { Option } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { parsePosition } from "./invocation";

describe("position parsing", () => {
  it("reads seconds and clock times", () => {
    expect(parsePosition("90")).toStrictEqual(Option.some(90_000));
    expect(parsePosition("12.5")).toStrictEqual(Option.some(12_500));
    expect(parsePosition("1:02:30")).toStrictEqual(Option.some(3_750_000));
    expect(parsePosition("2:05")).toStrictEqual(Option.some(125_000));
  });

  it("rejects anything else", () => {
    for (const text of ["", "-5", "1:2:3:4", "ten", "1:xx"]) {
      expect(parsePosition(text), text).toStrictEqual(Option.none());
    }
  });

  it("round-trips whole h:mm:ss times", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 99 }),
        fc.integer({ min: 0, max: 59 }),
        fc.integer({ min: 0, max: 59 }),
        (h, m, s) => {
          const text = `${String(h)}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;

          expect(parsePosition(text)).toStrictEqual(Option.some((h * 3600 + m * 60 + s) * 1000));
        },
      ),
    );
  });
});
