import { describe, expect, it } from "vitest";

import { avatarArt, avatarLabel, firstFreeAvatar, monogram } from "./avatars";

describe("avatars", () => {
  it("draws known keys as gradients and unknown keys as the plain tile", () => {
    expect(avatarArt({ avatar: "blue", kids: false })).toEqual({
      gradient: ["--color-avatar-blue-from", "--color-avatar-blue-to"],
      mark: "monogram",
    });
    expect(avatarArt({ avatar: "kids", kids: true }).mark).toBe("lettering");
    expect(avatarArt({ avatar: "fox", kids: false })).toEqual({ gradient: null, mark: "monogram" });
    expect(avatarArt({ avatar: "fox", kids: true })).toEqual({ gradient: null, mark: "kidsGlyph" });
  });

  it("starts new profiles on an avatar no other profile uses, never the kids art", () => {
    expect(firstFreeAvatar([])).toBe("red");
    expect(firstFreeAvatar(["red", "blue"])).toBe("green");
    expect(firstFreeAvatar(["red", "blue", "green", "plum", "teal", "slate"])).toBe("red");
  });

  it("writes the monogram and the spoken name", () => {
    expect(monogram("  alex ")).toBe("A");
    expect(monogram("")).toBe("");
    expect(avatarLabel("plum")).toBe("Plum");
  });
});
