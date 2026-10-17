import { describe, expect, it } from "vitest";

import { codeGroups, expiresInLine, spokenCode } from "./device-code";

describe("device code", () => {
  it("splits the code into its groups of boxes", () => {
    expect(codeGroups("bcdf-ghjk")).toEqual([
      ["B", "C", "D", "F"],
      ["G", "H", "J", "K"],
    ]);
    expect(codeGroups("J7K4P2")).toEqual([["J", "7", "K", "4", "P", "2"]]);
    expect(spokenCode("BCDF-GHJK")).toBe("B C D F, G H J K");
  });

  it("counts down to expiry", () => {
    expect(expiresInLine(292_000, 0)).toBe("Expires in 4:52");
    expect(expiresInLine(500, 0)).toBe("Expires in 0:01");
    expect(expiresInLine(0, 10_000)).toBe("Expires in 0:00");
  });
});
