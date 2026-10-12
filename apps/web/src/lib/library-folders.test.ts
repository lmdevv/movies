import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { folderProblem, normalizeFolder } from "./library-folders";

describe("library folders", () => {
  it("normalizes the way the server stores folders", () => {
    expect(normalizeFolder("  /mnt/nas/movies/ ")).toBe("/mnt/nas/movies");
    expect(normalizeFolder("///")).toBe("/");
    expect(normalizeFolder("")).toBe("");
  });

  it("accepts absolute paths and explains everything else", () => {
    expect(folderProblem("/mnt/nas/movies")).toBeNull();
    expect(folderProblem("")).toMatch(/path/u);
    expect(folderProblem("mnt/nas")).toMatch(/full path/u);
    expect(folderProblem("/mnt/../etc")).toMatch(/\.\./u);
  });

  it("is idempotent: a normalized folder normalizes to itself", () => {
    fc.assert(
      fc.property(fc.string(), (path) => {
        const once = normalizeFolder(path);

        expect(normalizeFolder(once)).toBe(once);
      }),
    );
  });
});
