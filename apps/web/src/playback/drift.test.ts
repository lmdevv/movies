import { MAX_DRIFT_MS, PlayerObservation } from "@movies/contracts/diagnostics";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DriftElement, PresentedFrame } from "./drift";
import { sampleDrift, videoAheadMs } from "./drift";

const HAVE_ENOUGH_DATA = 4;

const makeElement = (frame: (now: number) => PresentedFrame) => {
  const callbacks = new Map<number, (now: number, metadata: PresentedFrame) => void>();
  let handles = 0;

  const element = {
    paused: false,
    seeking: false,
    readyState: HAVE_ENOUGH_DATA,
    currentTime: 30,
    playbackRate: 1,
    requestVideoFrameCallback: (callback: (now: number, metadata: PresentedFrame) => void) => {
      handles += 1;
      callbacks.set(handles, callback);

      return handles;
    },
    cancelVideoFrameCallback: (handle: number) => {
      callbacks.delete(handle);
    },
    presentFrame: () => {
      const pending = [...callbacks.values()];

      callbacks.clear();

      for (const callback of pending) callback(performance.now(), frame(performance.now()));
    },
    requested: () => callbacks.size,
  };

  return element;
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("audio/video drift", () => {
  it("measures how far the frame shown is ahead of the media clock when it shows", () => {
    expect(
      videoAheadMs(
        { mediaTime: 30.04, expectedDisplayTime: 1_016 },
        { currentTime: 30, playbackRate: 1, performanceNow: 1_000 },
      ),
    ).toBe(24);
    expect(
      videoAheadMs(
        { mediaTime: 29.9, expectedDisplayTime: 1_000 },
        { currentTime: 30, playbackRate: 2, performanceNow: 1_000 },
      ),
    ).toBe(-100);
    expect(
      videoAheadMs(
        { mediaTime: 30.5, expectedDisplayTime: 1_250 },
        { currentTime: 30, playbackRate: 2, performanceNow: 1_000 },
      ),
    ).toBe(0);
  });

  it("holds a sample to the range the service accepts", () => {
    const clock = { currentTime: 0, playbackRate: 1, performanceNow: 0 };

    expect(videoAheadMs({ mediaTime: 600, expectedDisplayTime: 0 }, clock)).toBe(MAX_DRIFT_MS);
    expect(
      videoAheadMs({ mediaTime: 0, expectedDisplayTime: 0 }, { ...clock, currentTime: 600 }),
    ).toBe(-MAX_DRIFT_MS);
  });

  it("samples one frame every ten seconds while the element plays, and stops when told", () => {
    const element = makeElement((now) => ({ mediaTime: 29.96, expectedDisplayTime: now }));
    const observed: Array<PlayerObservation> = [];
    const stop = sampleDrift(element, (observation) => observed.push(observation));

    vi.advanceTimersByTime(9_999);
    expect(element.requested()).toBe(0);

    vi.advanceTimersByTime(1);
    vi.advanceTimersByTime(10_000);
    expect(element.requested()).toBe(1);

    element.presentFrame();
    expect(observed).toStrictEqual([
      PlayerObservation.cases.DriftSampled.make({ videoAheadMs: -40 }),
    ]);

    element.paused = true;
    vi.advanceTimersByTime(10_000);
    element.paused = false;
    element.seeking = true;
    vi.advanceTimersByTime(10_000);
    element.seeking = false;
    element.readyState = 2;
    vi.advanceTimersByTime(10_000);
    expect(element.requested()).toBe(0);

    element.readyState = HAVE_ENOUGH_DATA;
    vi.advanceTimersByTime(10_000);
    expect(element.requested()).toBe(1);

    stop();
    expect(element.requested()).toBe(0);
    vi.advanceTimersByTime(30_000);
    expect(element.requested()).toBe(0);
    expect(observed).toHaveLength(1);
  });

  it("sends nothing where the browser has no video frame callbacks", () => {
    const element: DriftElement = {
      paused: false,
      seeking: false,
      readyState: HAVE_ENOUGH_DATA,
      currentTime: 30,
      playbackRate: 1,
    };

    const observed: Array<PlayerObservation> = [];
    const stop = sampleDrift(element, (observation) => observed.push(observation));

    vi.advanceTimersByTime(60_000);
    stop();

    expect(observed).toStrictEqual([]);
  });
});
