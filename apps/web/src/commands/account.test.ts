import { describe, expect, it } from "vitest";

import { typedDeviceCode } from "./account";

describe("typedDeviceCode", () => {
  it("reads a code as the device shows it, in any case", () => {
    expect(typedDeviceCode("HD5R-5GTL")).toBe("HD5R-5GTL");
    expect(typedDeviceCode("  hd5r-5gtl ")).toBe("HD5R-5GTL");
  });

  it("leaves ordinary queries alone", () => {
    expect(typedDeviceCode("settings")).toBeNull();
    expect(typedDeviceCode("HD5R5GTL")).toBeNull();
    expect(typedDeviceCode("HD5R-5GT")).toBeNull();
    expect(typedDeviceCode("")).toBeNull();
  });
});
