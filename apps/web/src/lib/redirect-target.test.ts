import { describe, expect, it } from "vitest";

import { safeRedirect } from "./redirect-target";

describe("safeRedirect", () => {
  it("follows paths inside the app", () => {
    expect(safeRedirect("/title/abc?season=2")).toBe("/title/abc?season=2");
  });

  it("falls back home for missing or outside targets", () => {
    expect(safeRedirect(undefined)).toBe("/");
    expect(safeRedirect("https://example.com")).toBe("/");
    expect(safeRedirect("//example.com/x")).toBe("/");
    expect(safeRedirect("/\\example.com")).toBe("/");
  });
});
