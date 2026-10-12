import { describe, expect, it } from "vitest";

import { codeLetters, formatUserCode } from "./user-code";

describe("device user codes", () => {
  it("accepts a pasted code with its dash, spaces, or lower case", () => {
    expect(codeLetters("hd5r-5gtl")).toBe("HD5R5GTL");
    expect(codeLetters(" HD5R 5GTL ")).toBe("HD5R5GTL");
    expect(formatUserCode(codeLetters("hd5r-5gtl"))).toBe("HD5R-5GTL");
  });

  it("waits for all eight characters", () => {
    expect(formatUserCode("HD5R5GT")).toBeNull();
    expect(codeLetters("HD5R-5GTL-EXTRA")).toBe("HD5R5GTL");
  });
});
