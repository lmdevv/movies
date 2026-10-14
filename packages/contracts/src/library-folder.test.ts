import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { normalizeFolder } from "./library-folder";

describe("normalizeFolder", () => {
  it("trims, collapses repeated slashes, and drops trailing slashes and spaces", () => {
    expect(normalizeFolder("  /mnt/nas/movies/ ")).toBe("/mnt/nas/movies");
    expect(normalizeFolder("//srv//media//")).toBe("/srv/media");
    expect(normalizeFolder("/srv/a / /")).toBe("/srv/a");
    expect(normalizeFolder("! /")).toBe("!");
    expect(normalizeFolder("///")).toBe("/");
    expect(normalizeFolder("")).toBe("");
  });

  it("is idempotent: a normalized folder normalizes to itself", () => {
    fc.assert(
      fc.property(fc.string(), (path) => {
        const once = normalizeFolder(path);

        expect(normalizeFolder(once)).toBe(once);
      }),
      { numRuns: 2000 },
    );
  });

  it("handles a pasted run of thousands of trailing slashes in one pass", () => {
    expect(normalizeFolder(`/a${" /".repeat(100_000)}`)).toBe("/a");
  });
});
