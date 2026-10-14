import { describe, expect, it } from "vitest";

import { subtitleTrackLabel } from "./media-facts";

const track = {
  language: "eng",
  hearingImpaired: false,
  forced: false,
} as const;

describe("subtitleTrackLabel", () => {
  it("names text tracks by language, with CC and Forced", () => {
    expect(subtitleTrackLabel(track, 0)).toBe("English");
    expect(subtitleTrackLabel({ ...track, hearingImpaired: true }, 0)).toBe("English CC");
    expect(subtitleTrackLabel({ ...track, forced: true }, 0)).toBe("English (Forced)");
  });

  it("marks image tracks with their format so they never read like the text track", () => {
    expect(subtitleTrackLabel({ ...track, kind: "text", codec: "subrip" }, 0)).toBe("English");
    expect(subtitleTrackLabel({ ...track, kind: "bitmap", codec: "hdmv_pgs_subtitle" }, 1)).toBe(
      "English (PGS)",
    );
    expect(subtitleTrackLabel({ ...track, kind: "bitmap", codec: "dvd_subtitle" }, 1)).toBe(
      "English (VobSub)",
    );
    expect(subtitleTrackLabel({ ...track, kind: "bitmap", codec: "xsub" }, 1)).toBe(
      "English (image)",
    );
  });
});
