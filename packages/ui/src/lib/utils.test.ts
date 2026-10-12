import { describe, expect, it } from "vitest";

import { cn } from "./utils";

describe("cn", () => {
  it("keeps a Paper text size next to a Paper text color", () => {
    expect(cn("text-micro/3.5", "text-on-accent")).toBe("text-micro/3.5 text-on-accent");
    expect(cn("text-label/label text-danger")).toBe("text-label/label text-danger");
  });

  it("still lets a later class of the same group win", () => {
    expect(cn("text-label", "text-body")).toBe("text-body");
    expect(cn("rounded-control", "rounded-pill")).toBe("rounded-pill");
    expect(cn("text-text", "text-danger")).toBe("text-danger");
  });
});
