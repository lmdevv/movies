import { describe, expect, it } from "vitest";

import {
  DEFAULT_DOWNLOAD_SETTINGS,
  parseDownloadSettings,
  qualityLabel,
  serializeDownloadSettings,
} from "./settings";

describe("download settings", () => {
  it("reads back what it wrote, field by field with defaults", () => {
    const settings = { wifiOnly: false, quality: "high" } as const;

    expect(parseDownloadSettings(serializeDownloadSettings(settings))).toStrictEqual(settings);
    expect(parseDownloadSettings(null)).toStrictEqual(DEFAULT_DOWNLOAD_SETTINGS);
    expect(parseDownloadSettings('{"wifiOnly":false,"quality":"ultra"}')).toStrictEqual({
      wifiOnly: false,
      quality: "standard",
    });
    expect(qualityLabel("high")).toBe("High");
  });
});
