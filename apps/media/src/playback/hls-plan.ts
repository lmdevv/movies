/**
 * Segment boundaries and VOD playlists for HLS sessions. Transcodes cut on a fixed grid (the
 * encoder is told to place keyframes there); copies cut on source keyframes, grouped so each
 * segment lasts at least the target duration. Boundaries are seconds on the source timeline.
 */

/** Where each segment starts, and where the last one ends. */
export interface SegmentPlan {
  /** Start of each segment, ascending. Segment `i` covers `[starts[i], starts[i + 1] ?? end)`. */
  readonly starts: ReadonlyArray<number>;
  readonly end: number;
}

/** Target segment length for transcodes and the minimum grouping for copies. */
export const SEGMENT_SECONDS = 4;

/** A trailing segment shorter than this merges into the one before it. */
const MIN_TAIL_SECONDS = 0.5;

const withoutShortTail = (starts: ReadonlyArray<number>, end: number): ReadonlyArray<number> =>
  starts.length > 1 && end - (starts.at(-1) ?? end) < MIN_TAIL_SECONDS
    ? starts.slice(0, -1)
    : starts;

/** Fixed-length segments from `start` for `duration` seconds. */
export const planGridSegments = (
  start: number,
  duration: number,
  segmentSeconds = SEGMENT_SECONDS,
): SegmentPlan => {
  const count = Math.max(1, Math.ceil(duration / segmentSeconds));
  const end = start + duration;
  const starts = Array.from({ length: count }, (_, index) => start + index * segmentSeconds);

  return { starts: withoutShortTail(starts, end), end };
};

/**
 * Keyframe-aligned segments: each starts on a keyframe and lasts at least `targetSeconds`,
 * except the last. `keyframes` must be ascending.
 */
export const planKeyframeSegments = (
  keyframes: ReadonlyArray<number>,
  start: number,
  duration: number,
  targetSeconds = SEGMENT_SECONDS,
): SegmentPlan => {
  const end = start + duration;
  const usable = keyframes.filter((time) => time < end);
  const starts: Array<number> = [];

  for (const time of usable) {
    const previous = starts.at(-1);

    if (previous === undefined || time >= previous + targetSeconds) starts.push(time);
  }

  return { starts: withoutShortTail(starts.length === 0 ? [start] : starts, end), end };
};

/** Index of the segment containing `seconds`, clamped to the plan. */
export const segmentAt = (plan: SegmentPlan, seconds: number): number => {
  let low = 0;
  let high = plan.starts.length - 1;

  while (low < high) {
    const middle = Math.ceil((low + high) / 2);

    if ((plan.starts[middle] ?? Number.POSITIVE_INFINITY) <= seconds) low = middle;
    else high = middle - 1;
  }

  return low;
};

/** Length of segment `index` in seconds. */
export const segmentDuration = (plan: SegmentPlan, index: number): number =>
  (plan.starts[index + 1] ?? plan.end) - (plan.starts[index] ?? plan.end);

/** URIs a rendered playlist points at, relative to the playlist itself. */
export interface PlaylistUris {
  readonly init: string;
  readonly segment: (index: number) => string;
}

/** Renders a complete VOD media playlist for fMP4 segments. */
export const renderPlaylist = (plan: SegmentPlan, uris: PlaylistUris): string => {
  const durations = plan.starts.map((_, index) => segmentDuration(plan, index));
  const target = Math.max(1, Math.ceil(Math.max(...durations)));

  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    `#EXT-X-TARGETDURATION:${target}`,
    "#EXT-X-PLAYLIST-TYPE:VOD",
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-INDEPENDENT-SEGMENTS",
    `#EXT-X-MAP:URI="${uris.init}"`,
    ...durations.flatMap((duration, index) => [
      `#EXTINF:${duration.toFixed(6)},`,
      uris.segment(index),
    ]),
    "#EXT-X-ENDLIST",
  ];

  return `${lines.join("\n")}\n`;
};
