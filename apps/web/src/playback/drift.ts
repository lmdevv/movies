/**
 * A sample is accurate to about one frame. It cannot see timestamps already wrong in the stream:
 * a frame stamped late plays late and still lines up with the media clock.
 */
import { MAX_DRIFT_MS, PlayerObservation } from "@movies/contracts/diagnostics";

import type { Observe } from "./stream-attachment";

/** What `requestVideoFrameCallback` says about the frame it presents. */
export interface PresentedFrame {
  /** The frame's media time, in seconds. */
  readonly mediaTime: number;
  /** When the frame shows, on the `performance.now()` clock. */
  readonly expectedDisplayTime: number;
}

/** The element's media clock, read at `performanceNow` on the `performance.now()` clock. */
export interface MediaClock {
  readonly currentTime: number;
  readonly playbackRate: number;
  readonly performanceNow: number;
}

export interface DriftElement {
  readonly paused: boolean;
  readonly seeking: boolean;
  readonly readyState: number;
  readonly currentTime: number;
  readonly playbackRate: number;
  readonly requestVideoFrameCallback?: (
    callback: (now: number, metadata: PresentedFrame) => void,
  ) => number;
  readonly cancelVideoFrameCallback?: (handle: number) => void;
}

const SAMPLE_INTERVAL_MS = 10_000;

const HAVE_FUTURE_DATA = 3;

export const videoAheadMs = (frame: PresentedFrame, clock: MediaClock): number => {
  const clockAtDisplay =
    clock.currentTime +
    ((frame.expectedDisplayTime - clock.performanceNow) / 1000) * clock.playbackRate;

  return Math.min(
    MAX_DRIFT_MS,
    Math.max(-MAX_DRIFT_MS, Math.round((frame.mediaTime - clockAtDisplay) * 1000)),
  );
};

const playing = (element: DriftElement): boolean =>
  !element.paused && !element.seeking && element.readyState >= HAVE_FUTURE_DATA;

export const sampleDrift = (element: DriftElement, observe: Observe): (() => void) => {
  const { requestVideoFrameCallback, cancelVideoFrameCallback } = element;

  if (requestVideoFrameCallback === undefined) return () => undefined;
  let pending: number | null = null;

  const onFrame = (_now: number, frame: PresentedFrame): void => {
    pending = null;

    if (!playing(element)) return;

    const clock = {
      currentTime: element.currentTime,
      playbackRate: element.playbackRate,
      performanceNow: performance.now(),
    };

    const videoAhead = videoAheadMs(frame, clock);

    if (Number.isFinite(videoAhead)) {
      observe(PlayerObservation.cases.DriftSampled.make({ videoAheadMs: videoAhead }));
    }
  };

  const timer = setInterval(() => {
    if (pending === null && playing(element)) {
      pending = requestVideoFrameCallback.call(element, onFrame);
    }
  }, SAMPLE_INTERVAL_MS);

  return () => {
    clearInterval(timer);

    if (pending !== null) cancelVideoFrameCallback?.call(element, pending);
    pending = null;
  };
};
