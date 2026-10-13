/**
 * Segment boundaries and VOD playlists for HLS sessions. Transcodes cut on a fixed grid (the
 * encoder is told to place keyframes there); copies cut on source keyframes, grouped so each
 * segment lasts at least the target duration. Boundaries are seconds on the source timeline.
 *
 * Playback starts sooner on short segments: a player needs a whole segment before it shows a
 * frame, and an encoder needs to finish it. So the eight seconds from where a session starts are
 * cut short (1, 1, 2, 2, and 2 seconds for transcodes; one keyframe each for copies), and the
 * plan returns to its normal length after them. The plan is fixed for the session, so seeks and
 * new generations use the same boundaries.
 */

/** Where each segment starts, and where the last one ends. */
export interface SegmentPlan {
  /** Start of each segment, ascending. Segment `i` covers `[starts[i], starts[i + 1] ?? end)`. */
  readonly starts: ReadonlyArray<number>;
  readonly end: number;
}

/** Target segment length for transcodes and the minimum grouping for copies. */
const SEGMENT_SECONDS = 4;

/** A trailing segment shorter than this merges into the one before it. */
const MIN_TAIL_SECONDS = 0.5;

/** Where the short segments end, from the start of the grid cell playback starts in. */
const QUICK_GRID_OFFSETS: ReadonlyArray<number> = [1, 2, 4, 6];

/** How long after the start keyframe copies keep one keyframe per segment. */
const QUICK_COPY_SECONDS = 8;

/** Where a session starts, which its first segments are cut short around. */
export interface PlanOptions {
  /** Start position on the source timeline; none plans plain segments throughout. */
  readonly quickStart?: number;
}

const withoutShortTail = (starts: ReadonlyArray<number>, end: number): ReadonlyArray<number> =>
  starts.length > 1 && end - (starts.at(-1) ?? end) < MIN_TAIL_SECONDS
    ? starts.slice(0, -1)
    : starts;

/**
 * Fixed-length segments from `start` for `duration` seconds; the two grid cells from
 * `options.quickStart` are cut into 1, 1, 2, 2, and 2 second segments.
 */
export const planGridSegments = (
  start: number,
  duration: number,
  options: PlanOptions = {},
): SegmentPlan => {
  const count = Math.max(1, Math.ceil(duration / SEGMENT_SECONDS));
  const end = start + duration;
  const grid = Array.from({ length: count }, (_, index) => start + index * SEGMENT_SECONDS);

  const cell =
    options.quickStart === undefined
      ? undefined
      : Math.min(
          count - 1,
          Math.max(0, Math.floor((options.quickStart - start) / SEGMENT_SECONDS)),
        );

  const quick =
    cell === undefined
      ? []
      : QUICK_GRID_OFFSETS.flatMap((offset) => {
          const time = start + cell * SEGMENT_SECONDS + offset;

          return time < end ? [time] : [];
        });

  const starts = [...new Set([...grid, ...quick])].toSorted((left, right) => left - right);

  return { starts: withoutShortTail(starts, end), end };
};

/**
 * Keyframe-aligned segments: each starts on a keyframe and lasts at least the target length,
 * except the last. From the keyframe at or before `options.quickStart`, segments hold one
 * keyframe each for eight seconds. `keyframes` must be ascending.
 */
export const planKeyframeSegments = (
  keyframes: ReadonlyArray<number>,
  start: number,
  duration: number,
  options: PlanOptions = {},
): SegmentPlan => {
  const end = start + duration;
  const usable = keyframes.filter((time) => time < end);
  const starts: Array<number> = [];
  const { quickStart } = options;

  const quickFrom =
    quickStart === undefined ? undefined : usable.findLast((time) => time <= quickStart);

  const isQuick = (time: number): boolean =>
    quickFrom !== undefined && time >= quickFrom && time < quickFrom + QUICK_COPY_SECONDS;

  for (const time of usable) {
    const previous = starts.at(-1);

    if (
      previous === undefined ||
      time === quickFrom ||
      isQuick(previous) ||
      time >= previous + SEGMENT_SECONDS
    ) {
      starts.push(time);
    }
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
const segmentDuration = (plan: SegmentPlan, index: number): number =>
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
