import { describe, expect, it } from "vitest";

import { folderTroubleOf } from "./scan-failure";

describe("folderTroubleOf", () => {
  it("tells an unreachable folder from a refused one and from other failures", () => {
    expect(folderTroubleOf("Library root unavailable: /mnt/nas (missing); known files")).toBe(
      "offline",
    );
    expect(folderTroubleOf("Library folder unreadable: Movies (EIO); known files")).toBe("offline");
    expect(folderTroubleOf("Library root not approved: /etc is outside LIBRARY_ROOTS")).toBe(
      "notApproved",
    );
    expect(folderTroubleOf("This library was removed")).toBeNull();
    expect(folderTroubleOf(null)).toBeNull();
  });
});
