import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { formatTimecode } from "./timecode";

const parse = (timecode: string): number => {
  const sign = timecode.startsWith("-") ? -1 : 1;
  const parts = timecode.replace("-", "").split(":").map(Number);

  return sign * parts.reduce((total, part) => total * 60 + part, 0);
};

describe("formatTimecode", () => {
  it("formats positions like the player", () => {
    expect(formatTimecode(0)).toBe("0:00");
    expect(formatTimecode(65)).toBe("1:05");
    expect(formatTimecode(3600)).toBe("1:00:00");
    expect(formatTimecode(-5598)).toBe("-1:33:18");
    expect(formatTimecode(59.9)).toBe("0:59");
    expect(formatTimecode(Number.NaN)).toBe("0:00");
  });

  it("round-trips whole seconds", () => {
    fc.assert(
      fc.property(fc.integer({ min: -400_000, max: 400_000 }), (seconds) => {
        expect(parse(formatTimecode(seconds))).toBe(seconds);
      }),
    );
  });
});
