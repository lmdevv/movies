import { describe, expect, it } from "vitest";

import { parseQualityChoice, QUALITY_OPTIONS, qualityCap } from "./quality";

describe("quality choice", () => {
  it("offers Auto and Original without a cap, and caps the rest by height and bitrate", () => {
    expect(QUALITY_OPTIONS.map((option) => option.label)).toStrictEqual([
      "Auto",
      "Original",
      "1080p",
      "720p",
      "480p",
    ]);
    expect(qualityCap("auto")).toBeUndefined();
    expect(qualityCap("original")).toBeUndefined();
    expect(qualityCap("720p")).toStrictEqual({ maxHeight: 720, maxBitrate: 4_000_000 });
  });

  it("reads only known choices back", () => {
    expect(parseQualityChoice("480p")).toBe("480p");
    expect(parseQualityChoice("4k")).toBeUndefined();
  });
});
