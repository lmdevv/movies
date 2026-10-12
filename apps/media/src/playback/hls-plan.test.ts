import { describe, expect, it } from "@effect/vitest";

import { planGridSegments, planKeyframeSegments, renderPlaylist, segmentAt } from "./hls-plan.ts";

describe("HLS segment plans", () => {
  it("cuts transcodes on a fixed grid and merges a tiny tail", () => {
    expect(planGridSegments(0, 12)).toStrictEqual({ starts: [0, 4, 8], end: 12 });
    expect(planGridSegments(1.5, 10.2)).toStrictEqual({ starts: [1.5, 5.5, 9.5], end: 11.7 });
    expect(planGridSegments(0, 8.3)).toStrictEqual({ starts: [0, 4], end: 8.3 });
  });

  it("groups keyframes into segments of at least the target length", () => {
    const keyframes = [0, 1, 2.5, 4.2, 5, 9, 10, 15.9];

    expect(planKeyframeSegments(keyframes, 0, 16)).toStrictEqual({ starts: [0, 4.2, 9], end: 16 });
    expect(planKeyframeSegments([0, 10, 20], 0, 25)).toStrictEqual({
      starts: [0, 10, 20],
      end: 25,
    });
    expect(planKeyframeSegments([], 0, 25)).toStrictEqual({ starts: [0], end: 25 });
  });

  it("finds the segment containing a time", () => {
    const plan = { starts: [0, 4.2, 9], end: 16 };

    expect([0, 4.1, 4.2, 8.99, 9, 15, 100, -1].map((time) => segmentAt(plan, time))).toStrictEqual([
      0, 0, 1, 1, 2, 2, 2, 0,
    ]);
  });

  it("renders a VOD playlist", () => {
    const playlist = renderPlaylist(
      { starts: [0, 4.2, 9], end: 16 },
      { init: "init.mp4?t=1", segment: (index) => `${index}.m4s?t=1` },
    );

    expect(playlist).toBe(
      [
        "#EXTM3U",
        "#EXT-X-VERSION:7",
        "#EXT-X-TARGETDURATION:7",
        "#EXT-X-PLAYLIST-TYPE:VOD",
        "#EXT-X-MEDIA-SEQUENCE:0",
        "#EXT-X-INDEPENDENT-SEGMENTS",
        '#EXT-X-MAP:URI="init.mp4?t=1"',
        "#EXTINF:4.200000,",
        "0.m4s?t=1",
        "#EXTINF:4.800000,",
        "1.m4s?t=1",
        "#EXTINF:7.000000,",
        "2.m4s?t=1",
        "#EXT-X-ENDLIST",
        "",
      ].join("\n"),
    );
  });
});
