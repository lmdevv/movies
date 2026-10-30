import { describe, expect, it } from "vitest";

import { widthClassOf } from "./layout";

const breakpoints = { regular: 700, wide: 1100 };

describe("layout", () => {
  it("gives every iPhone and a narrow iPad window the compact layout", () => {
    expect(widthClassOf(375, breakpoints)).toBe("compact");
    expect(widthClassOf(440, breakpoints)).toBe("compact");
    expect(widthClassOf(694, breakpoints)).toBe("compact");
  });

  it("gives an iPad in portrait the regular layout and in landscape the wide one", () => {
    expect(widthClassOf(744, breakpoints)).toBe("regular");
    expect(widthClassOf(1032, breakpoints)).toBe("regular");
    expect(widthClassOf(1133, breakpoints)).toBe("wide");
    expect(widthClassOf(1376, breakpoints)).toBe("wide");
  });
});
