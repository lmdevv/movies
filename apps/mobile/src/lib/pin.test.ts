import { describe, expect, it } from "vitest";

import { lockoutLine, pressKey, wrongPinLine } from "./pin";

describe("pin", () => {
  it("adds digits up to four and deletes the last one", () => {
    expect(pressKey("", "1")).toBe("1");
    expect(pressKey("123", "4")).toBe("1234");
    expect(pressKey("1234", "5")).toBe("1234");
    expect(pressKey("12", "delete")).toBe("1");
    expect(pressKey("", "delete")).toBe("");
  });

  it("says how long a locked profile waits, rounding up", () => {
    expect(lockoutLine(90_000, 0)).toBe("Try again in 2 minutes.");
    expect(lockoutLine(60_000, 0)).toBe("Try again in 1 minute.");
    expect(lockoutLine(1000, 5000)).toBe("Try again now.");
  });

  it("counts tries left once few remain", () => {
    expect(wrongPinLine(4)).toBe("Incorrect PIN. Try again.");
    expect(wrongPinLine(2)).toBe("Incorrect PIN. 2 tries left.");
    expect(wrongPinLine(1)).toBe("Incorrect PIN. 1 try left.");
  });
});
