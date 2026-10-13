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

  it("cuts the first transcode segments short from where playback starts", () => {
    expect(planGridSegments(0, 30, { quickStart: 0 }).starts).toStrictEqual([
      0, 1, 2, 4, 6, 8, 12, 16, 20, 24, 28,
    ]);

    // Resuming at 13.5 s: the cell it falls in and the next one are cut short; the grid elsewhere
    // is the same as without a quick start, so every other boundary stays where it was.
    const resumed = planGridSegments(0, 30, { quickStart: 13.5 });

    expect(resumed.starts).toStrictEqual([0, 4, 8, 12, 13, 14, 16, 18, 20, 24, 28]);
    expect(resumed.starts.filter((time) => time % 4 === 0)).toStrictEqual(
      planGridSegments(0, 30).starts,
    );
    expect(planGridSegments(0, 30, { quickStart: 29 }).starts.at(-1)).toBe(29);
    expect(planGridSegments(0, 1.2, { quickStart: 0 })).toStrictEqual({ starts: [0], end: 1.2 });
  });

  it("gives copies one keyframe per segment for eight seconds from the start keyframe", () => {
    const keyframes = Array.from({ length: 20 }, (_, index) => index * 2);

    expect(planKeyframeSegments(keyframes, 0, 40, { quickStart: 0 }).starts).toStrictEqual([
      0, 2, 4, 6, 8, 12, 16, 20, 24, 28, 32, 36,
    ]);

    // Resuming at 21 s: a segment starts on the keyframe at 20 s even though grouping from the
    // beginning would not cut there.
    const resumed = planKeyframeSegments(keyframes, 0, 40, { quickStart: 21 }).starts;

    expect(resumed).toStrictEqual([0, 4, 8, 12, 16, 20, 22, 24, 26, 28, 32, 36]);
    expect(resumed.every((time) => keyframes.includes(time))).toBe(true);
  });

  it("keeps every plan continuous and ascending around the switch to normal length", () => {
    for (const quickStart of [0, 3.9, 4, 17.25, 59.9]) {
      const grid = planGridSegments(0.04, 60, { quickStart });

      const copy = planKeyframeSegments(
        Array.from({ length: 50 }, (_, index) => 0.04 + index * 1.2),
        0.04,
        60,
        { quickStart },
      );

      for (const plan of [grid, copy]) {
        const durations = plan.starts.map(
          (time, index) => (plan.starts[index + 1] ?? plan.end) - time,
        );

        expect(durations.every((duration) => duration > 0)).toBe(true);
        expect(durations.reduce((total, duration) => total + duration, 0)).toBeCloseTo(60, 6);
        expect(plan.starts[segmentAt(plan, quickStart)]).toBeLessThanOrEqual(quickStart + 0.04);
        expect(Math.max(...durations.slice(segmentAt(plan, quickStart), -1))).toBeLessThan(6);
      }
    }
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
