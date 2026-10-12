/**
 * Reads video keyframe times from a Matroska file's Cues index without reading its media data.
 * Matroska muxers (mkvmerge, ffmpeg) write a cue point for every video keyframe, so the index
 * gives copy-mode HLS its segment boundaries in a few small reads instead of a full-file scan.
 *
 * The parser follows the EBML structure: the Segment's SeekHead locates Info (timestamp scale),
 * Tracks (which track is video), and Cues. Files without Cues return `Option.none()`.
 */
import { Effect, Option } from "effect";

/** Reads `length` bytes at `position`; a shorter result means the file ended. */
export type ReadAt<E> = (position: number, length: number) => Effect.Effect<Uint8Array, E>;

const ID = {
  ebml: 0x1a_45_df_a3,
  segment: 0x18_53_80_67,
  seekHead: 0x11_4d_9b_74,
  seek: 0x4d_bb,
  seekId: 0x53_ab,
  seekPosition: 0x53_ac,
  info: 0x15_49_a9_66,
  timestampScale: 0x2a_d7_b1,
  tracks: 0x16_54_ae_6b,
  trackEntry: 0xae,
  trackNumber: 0xd7,
  trackType: 0x83,
  cues: 0x1c_53_bb_6b,
  cuePoint: 0xbb,
  cueTime: 0xb3,
  cueTrackPositions: 0xb7,
  cueTrack: 0xf7,
  cluster: 0x1f_43_b6_75,
} as const;

const VIDEO_TRACK_TYPE = 1;

const DEFAULT_TIMESTAMP_SCALE = 1_000_000;

const HEADER_BYTES = 12;

const MAX_ELEMENT_BYTES = 64 * 1024 * 1024;

const MAX_TOP_LEVEL_STEPS = 256;

interface Vint {
  readonly value: number;
  readonly length: number;
  /** All value bits set: the EBML "unknown size" marker. */
  readonly unknown: boolean;
}

/** Reads an EBML variable-length integer; `keepMarker` keeps the length bit (element IDs). */
const readVint = (bytes: Uint8Array, offset: number, keepMarker: boolean): Vint | undefined => {
  const first = bytes[offset];

  if (first === undefined || first === 0) return undefined;
  const length = Math.clz32(first) - 23;

  if (length > 8 || offset + length > bytes.length) return undefined;
  let value = keepMarker ? first : first & (0xff >> length);
  let allOnes = value === 0xff >> length;

  for (let index = 1; index < length; index += 1) {
    const byte = bytes[offset + index] ?? 0;
    value = value * 256 + byte;
    allOnes &&= byte === 0xff;
  }

  return { value, length, unknown: !keepMarker && allOnes };
};

interface Element {
  readonly id: number;
  /** Offset of the element's data, relative to the buffer or file it was read from. */
  readonly dataStart: number;
  /** Data size in bytes; `undefined` for an unknown-size element. */
  readonly size: number | undefined;
}

const readHeader = (bytes: Uint8Array, offset: number): Element | undefined => {
  const id = readVint(bytes, offset, true);

  if (id === undefined) return undefined;
  const size = readVint(bytes, offset + id.length, false);

  if (size === undefined) return undefined;

  return {
    id: id.value,
    dataStart: offset + id.length + size.length,
    size: size.unknown ? undefined : size.value,
  };
};

/** The child elements in `bytes[start, end)`. */
const children = (bytes: Uint8Array, start: number, end: number): ReadonlyArray<Element> => {
  const found: Array<Element> = [];
  let offset = start;

  while (offset < end) {
    const element = readHeader(bytes, offset);

    if (element?.size === undefined || element.dataStart + element.size > end) break;
    found.push(element);
    offset = element.dataStart + element.size;
  }

  return found;
};

const uint = (bytes: Uint8Array, element: Element): number => {
  let value = 0;

  for (let index = 0; index < (element.size ?? 0); index += 1) {
    value = value * 256 + (bytes[element.dataStart + index] ?? 0);
  }

  return value;
};

const childrenOf = (bytes: Uint8Array, element: Element): ReadonlyArray<Element> =>
  children(bytes, element.dataStart, element.dataStart + (element.size ?? 0));

const firstUint = (bytes: Uint8Array, parent: Element, id: number): number | undefined => {
  const child = childrenOf(bytes, parent).find((element) => element.id === id);

  return child === undefined ? undefined : uint(bytes, child);
};

/** Seek positions (relative to the segment data) by element ID. */
const seekPositions = (bytes: Uint8Array, seekHead: Element): ReadonlyMap<number, number> => {
  const positions = new Map<number, number>();

  for (const seek of childrenOf(bytes, seekHead).filter((element) => element.id === ID.seek)) {
    const fields = childrenOf(bytes, seek);
    const idField = fields.find((element) => element.id === ID.seekId);
    const position = fields.find((element) => element.id === ID.seekPosition);

    if (idField === undefined || position === undefined) continue;
    positions.set(uint(bytes, idField), uint(bytes, position));
  }

  return positions;
};

const videoTrackNumber = (bytes: Uint8Array, tracks: Element): number | undefined =>
  childrenOf(bytes, tracks)
    .filter((element) => element.id === ID.trackEntry)
    .map((entry) => ({
      number: firstUint(bytes, entry, ID.trackNumber),
      type: firstUint(bytes, entry, ID.trackType),
    }))
    .find((entry) => entry.type === VIDEO_TRACK_TYPE)?.number;

const cueTimes = (
  bytes: Uint8Array,
  cues: Element,
  track: number | undefined,
): ReadonlyArray<number> =>
  childrenOf(bytes, cues)
    .filter((element) => element.id === ID.cuePoint)
    .flatMap((point) => {
      const fields = childrenOf(bytes, point);
      const time = fields.find((element) => element.id === ID.cueTime);

      const tracks = fields
        .filter((element) => element.id === ID.cueTrackPositions)
        .map((positions) => firstUint(bytes, positions, ID.cueTrack));

      return time !== undefined && (track === undefined || tracks.includes(track))
        ? [uint(bytes, time)]
        : [];
    });

/**
 * Video keyframe times in seconds, ascending, from the Cues of the Matroska file behind `read`.
 * `Option.none()` when the file is not Matroska or has no usable Cues.
 */
export const readMatroskaKeyframes = Effect.fnUntraced(function* <E>(read: ReadAt<E>) {
  const head = yield* read(0, 64 * 1024);
  const ebml = readHeader(head, 0);

  if (ebml?.id !== ID.ebml || ebml.size === undefined) return Option.none<ReadonlyArray<number>>();
  const segment = readHeader(head, ebml.dataStart + ebml.size);

  if (segment?.id !== ID.segment) return Option.none<ReadonlyArray<number>>();
  const segmentStart = segment.dataStart;

  /** Reads a whole top-level element whose header starts at `position` in the file. */
  const readElement = Effect.fnUntraced(function* (position: number) {
    const header = yield* read(position, HEADER_BYTES);
    const element = readHeader(header, 0);

    if (element?.size === undefined || element.size > MAX_ELEMENT_BYTES) return undefined;
    const bytes = yield* read(position, element.dataStart + element.size);

    return { bytes, element };
  });

  const found = new Map<number, { readonly bytes: Uint8Array; readonly element: Element }>();
  let seeks: ReadonlyMap<number, number> = new Map();
  let position = segmentStart;

  // Walk top-level elements until the first cluster; most muxers put SeekHead, Info, and Tracks there.
  for (let step = 0; step < MAX_TOP_LEVEL_STEPS; step += 1) {
    const header = readHeader(yield* read(position, HEADER_BYTES), 0);

    if (header?.size === undefined || header.id === ID.cluster) break;

    if (
      header.id === ID.seekHead ||
      header.id === ID.info ||
      header.id === ID.tracks ||
      header.id === ID.cues
    ) {
      const whole = yield* readElement(position);

      if (whole !== undefined) found.set(header.id, whole);

      if (whole !== undefined && header.id === ID.seekHead) {
        seeks = new Map([...seeks, ...seekPositions(whole.bytes, whole.element)]);
      }
    }

    position += header.dataStart + header.size;
  }

  for (const id of [ID.info, ID.tracks, ID.cues]) {
    const seekPosition = seeks.get(id);

    if (found.has(id) || seekPosition === undefined) continue;
    const whole = yield* readElement(segmentStart + seekPosition);

    if (whole?.element.id === id) found.set(id, whole);
  }

  const cues = found.get(ID.cues);

  if (cues === undefined) return Option.none<ReadonlyArray<number>>();
  const info = found.get(ID.info);
  const tracks = found.get(ID.tracks);

  const scale =
    (info === undefined ? undefined : firstUint(info.bytes, info.element, ID.timestampScale)) ??
    DEFAULT_TIMESTAMP_SCALE;

  const track = tracks === undefined ? undefined : videoTrackNumber(tracks.bytes, tracks.element);

  const times = [...new Set(cueTimes(cues.bytes, cues.element, track))].toSorted(
    (left, right) => left - right,
  );

  return times.length === 0
    ? Option.none<ReadonlyArray<number>>()
    : Option.some(times.map((time) => (time * scale) / 1e9));
});
