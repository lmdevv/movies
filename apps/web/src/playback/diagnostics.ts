/**
 * What the web player tells the media service about playback (`PlayerDiagnostics` in the SDK):
 * how much the element holds ahead, the frames it dropped, and the observations for a stream
 * failure and for the recovery the controller chose. hls.js segment loads and errors are recorded
 * where hls.js runs (`stream-attachment.ts`).
 */
import { PlayerObservation, type RecoveryAction } from "@movies/contracts/diagnostics";
import type { PlayerDiagnostics } from "@movies/sdk/effect";
import { Option } from "effect";

import type { TimeRangesLike } from "./media-element-player";
import { PlaybackStep } from "./playback-policy";
import type { StreamFailure } from "./stream-attachment";

/** The parts of a `<video>` element the diagnostics read. */
export interface DiagnosedElement {
  readonly currentTime: number;
  readonly buffered: TimeRangesLike;
  /** Absent in browsers without the Media Playback Quality API. */
  readonly getVideoPlaybackQuality?: () => {
    readonly droppedVideoFrames: number;
    readonly totalVideoFrames: number;
  };
}

/** Seconds the element holds from its position to the end of the range around it; 0 when none. */
export const bufferedAheadSeconds = (element: DiagnosedElement): number => {
  const { buffered, currentTime } = element;

  const ends = Array.from({ length: buffered.length }, (_, index) => index).flatMap((index) =>
    buffered.start(index) <= currentTime + 0.5 && currentTime <= buffered.end(index)
      ? [buffered.end(index)]
      : [],
  );

  return Math.max(0, ...ends.map((end) => end - currentTime));
};

/** The frames the element dropped and decoded so far, where the browser counts them. */
export const frameCounts = (
  element: DiagnosedElement,
): Option.Option<PlayerDiagnostics.FrameCounts> =>
  Option.map(Option.fromNullishOr(element.getVideoPlaybackQuality), (quality) => {
    const counts = quality.call(element);

    return { dropped: counts.droppedVideoFrames, decoded: counts.totalVideoFrames };
  });

/** A stream failure in a sentence. */
export const describeFailure = (failure: StreamFailure): string => {
  if (failure.kind === "http")
    return `A media request was answered with HTTP ${String(failure.status)}`;

  return failure.kind === "media"
    ? "The browser could not demux or decode the stream"
    : "A media request got no answer";
};

/** What a failure of the stream in the element looks like to the service. */
export const failureObservation = (
  failure: StreamFailure,
  engine: "hls.js" | "element",
): PlayerObservation =>
  PlayerObservation.cases.PlayerError.make({
    source: engine === "hls.js" ? "hls.js" : "html-video",
    kind: failure.kind,
    detail: describeFailure(failure),
    fatal: true,
    status: failure.kind === "http" ? failure.status : undefined,
  });

/** The recovery action of a step that tries again; none for one that stops. */
const actionOf = (step: PlaybackStep): Option.Option<RecoveryAction> =>
  PlaybackStep.$match(step, {
    ReloadPlaylist: () => Option.some<RecoveryAction>("reload-playlist"),
    Renegotiate: () => Option.some<RecoveryAction>("renegotiate"),
    TryAnotherWay: () => Option.some<RecoveryAction>("try-another-way"),
    NewSession: () => Option.some<RecoveryAction>("new-session"),
    Stop: () => Option.none(),
  });

/** The recovery `step` takes after `reason`, as an observation; none for a step that stops. */
export const recoveryObservation = (
  step: PlaybackStep,
  reason: string,
): Option.Option<PlayerObservation> =>
  Option.map(actionOf(step), (action) =>
    PlayerObservation.cases.Recovery.make({ action, reason: reason.slice(0, 120) }),
  );
