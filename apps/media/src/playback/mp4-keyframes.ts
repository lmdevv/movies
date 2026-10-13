/**
 * Reads video keyframe times from an MP4 or QuickTime file's sample tables without reading its
 * media data. The `moov` box describes every sample: `stts` gives decode times, `ctts` the offset
 * to presentation times, and `stss` which samples are sync (key) frames; an edit list (`elst`)
 * shifts the timeline the way ffmpeg's demuxer does, so the times match an ffprobe packet scan.
 *
 * Only the simple, common shapes are read: one optional leading empty edit and one media edit.
 * Fragmented MP4 (samples in `moof` boxes), several media edits, or anything malformed returns
 * `Option.none()`, and the caller scans packets instead.
 */
import { Effect, Option } from "effect";

import type { ReadAt } from "./matroska-cues.ts";

/** The largest `moov` read into memory; a two-hour film's is a few megabytes. */
const MAX_MOOV_BYTES = 64 * 1024 * 1024;

/** Top-level boxes walked before giving up on finding `moov`. */
const MAX_TOP_LEVEL_BOXES = 64;

const HEADER_BYTES = 16;

/** A box: its type, where its payload starts, and where it ends, relative to `bytes`. */
interface Box {
  readonly type: string;
  readonly start: number;
  readonly end: number;
}

const typeAt = (bytes: Uint8Array, offset: number): string =>
  String.fromCodePoint(...bytes.subarray(offset, offset + 4));

const uint32 = (view: DataView, offset: number): number => view.getUint32(offset);

const uint64 = (view: DataView, offset: number): number => Number(view.getBigUint64(offset));

/** The box header at `offset`, or undefined when it does not fit in `limit`. */
const headerAt = (view: DataView, offset: number, limit: number): Box | undefined => {
  if (offset + 8 > limit) return undefined;
  const size32 = uint32(view, offset);
  const type = typeAt(new Uint8Array(view.buffer, view.byteOffset, view.byteLength), offset + 4);

  if (size32 === 1) {
    if (offset + 16 > limit) return undefined;
    const size = uint64(view, offset + 8);

    return size < 16 ? undefined : { type, start: offset + 16, end: offset + size };
  }

  const end = size32 === 0 ? limit : offset + size32;

  return size32 !== 0 && size32 < 8 ? undefined : { type, start: offset + 8, end };
};

/** The child boxes of the payload `[start, end)`. */
const children = (view: DataView, start: number, end: number): ReadonlyArray<Box> => {
  const boxes: Array<Box> = [];

  for (let offset = start; offset < end;) {
    const box = headerAt(view, offset, end);

    if (box === undefined || box.end > end) break;
    boxes.push(box);
    offset = box.end;
  }

  return boxes;
};

const child = (view: DataView, parent: Box, type: string): Box | undefined =>
  children(view, parent.start, parent.end).find((box) => box.type === type);

const path = (view: DataView, parent: Box, types: ReadonlyArray<string>): Box | undefined =>
  types.reduce<Box | undefined>(
    (box, type) => (box === undefined ? undefined : child(view, box, type)),
    parent,
  );

/** A full box's version byte, after which its fields start four bytes in. */
const versionOf = (view: DataView, box: Box): number => view.getUint8(box.start);

/** `mvhd` or `mdhd` timescale. */
const timescaleOf = (view: DataView, box: Box): number =>
  uint32(view, box.start + (versionOf(view, box) === 1 ? 20 : 12));

/** The decode time of every sample, in media timescale units, from `stts`. */
const decodeTimes = (view: DataView, stts: Box): ReadonlyArray<number> => {
  const count = uint32(view, stts.start + 4);
  const times: Array<number> = [];
  let time = 0;

  for (let entry = 0; entry < count; entry += 1) {
    const offset = stts.start + 8 + entry * 8;
    const samples = uint32(view, offset);
    const delta = uint32(view, offset + 4);

    for (let sample = 0; sample < samples; sample += 1) {
      times.push(time);
      time += delta;
    }
  }

  return times;
};

/** The composition offset of every sample from `ctts`; zeros without one. */
const compositionOffsets = (
  view: DataView,
  ctts: Box | undefined,
  samples: number,
): ReadonlyArray<number> => {
  const offsets = Array.from({ length: samples }, () => 0);

  if (ctts === undefined) return offsets;
  const signed = versionOf(view, ctts) === 1;
  const count = uint32(view, ctts.start + 4);
  let index = 0;

  for (let entry = 0; entry < count; entry += 1) {
    const offset = ctts.start + 8 + entry * 8;
    const run = uint32(view, offset);
    const value = signed ? view.getInt32(offset + 4) : uint32(view, offset + 4);

    for (let sample = 0; sample < run && index < samples; sample += 1) {
      offsets[index] = value;
      index += 1;
    }
  }

  return offsets;
};

/** 1-based sync sample numbers from `stss`; none means every sample is a sync sample. */
const syncSamples = (view: DataView, stss: Box | undefined): ReadonlyArray<number> | undefined => {
  if (stss === undefined) return undefined;
  const count = uint32(view, stss.start + 4);

  return Array.from({ length: count }, (_, entry) => uint32(view, stss.start + 8 + entry * 4));
};

/**
 * The shift the edit list applies, in seconds, with `media` time to subtract (media timescale)
 * and `delay` from a leading empty edit (movie timescale); undefined for shapes not handled.
 */
const editShift = (
  view: DataView,
  trak: Box,
  movieTimescale: number,
  mediaTimescale: number,
): number | undefined => {
  const elst = path(view, trak, ["edts", "elst"]);

  if (elst === undefined) return 0;
  const wide = versionOf(view, elst) === 1;
  const count = uint32(view, elst.start + 4);
  const entrySize = wide ? 20 : 12;
  let delay = 0;
  const media: Array<number> = [];

  for (let entry = 0; entry < count; entry += 1) {
    const offset = elst.start + 8 + entry * entrySize;
    const duration = wide ? uint64(view, offset) : uint32(view, offset);
    const mediaTime = wide ? Number(view.getBigInt64(offset + 8)) : view.getInt32(offset + 4);

    if (mediaTime === -1) {
      if (media.length > 0) return undefined;
      delay += duration;
    } else {
      media.push(mediaTime);
    }
  }

  if (media.length > 1) return undefined;

  return delay / movieTimescale - (media[0] ?? 0) / mediaTimescale;
};

/** Keyframe times in seconds from a whole `moov` box. */
const keyframesFromMoov = (view: DataView, moov: Box): Option.Option<ReadonlyArray<number>> => {
  if (child(view, moov, "mvex") !== undefined) return Option.none();
  const mvhd = child(view, moov, "mvhd");

  const trak = children(view, moov.start, moov.end).find((box) => {
    const hdlr = box.type === "trak" ? path(view, box, ["mdia", "hdlr"]) : undefined;

    return (
      hdlr !== undefined &&
      typeAt(new Uint8Array(view.buffer, view.byteOffset), hdlr.start + 8) === "vide"
    );
  });

  const mdhd = trak === undefined ? undefined : path(view, trak, ["mdia", "mdhd"]);
  const stbl = trak === undefined ? undefined : path(view, trak, ["mdia", "minf", "stbl"]);
  const stts = stbl === undefined ? undefined : child(view, stbl, "stts");

  if (
    mvhd === undefined ||
    trak === undefined ||
    mdhd === undefined ||
    stbl === undefined ||
    stts === undefined
  ) {
    return Option.none();
  }

  const timescale = timescaleOf(view, mdhd);
  const shift = editShift(view, trak, timescaleOf(view, mvhd), timescale);
  const decode = decodeTimes(view, stts);

  if (timescale === 0 || shift === undefined || decode.length === 0) return Option.none();
  const offsets = compositionOffsets(view, child(view, stbl, "ctts"), decode.length);
  const sync = syncSamples(view, child(view, stbl, "stss")) ?? decode.map((_, index) => index + 1);

  const times = sync
    .map((number) => decode[number - 1])
    .flatMap((time, index) => {
      const sample = sync[index] ?? 0;

      return time === undefined ? [] : [(time + (offsets[sample - 1] ?? 0)) / timescale + shift];
    })
    .toSorted((left, right) => left - right);

  return times.length === 0 ? Option.none() : Option.some(times);
};

/**
 * Keyframe times in seconds of an MP4 or QuickTime file of `size` bytes, read through `read`;
 * none when the file has no usable sample tables.
 */
export const readMp4Keyframes = Effect.fnUntraced(function* <E>(read: ReadAt<E>, size: number) {
  let position = 0;

  for (let step = 0; step < MAX_TOP_LEVEL_BOXES && position + 8 <= size; step += 1) {
    const head = yield* read(position, HEADER_BYTES);

    if (head.byteLength < 8) return Option.none<ReadonlyArray<number>>();
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    const size32 = uint32(view, 0);
    const wide = size32 === 1 && head.byteLength >= 16;
    const boxSize = wide ? uint64(view, 8) : size32 === 0 ? size - position : size32;
    const headerSize = wide ? 16 : 8;

    if (boxSize < headerSize || (size32 === 1 && !wide))
      return Option.none<ReadonlyArray<number>>();

    if (typeAt(head, 4) === "moov") {
      if (boxSize > MAX_MOOV_BYTES) return Option.none<ReadonlyArray<number>>();
      const bytes = yield* read(position, boxSize);

      if (bytes.byteLength < boxSize) return Option.none<ReadonlyArray<number>>();

      return keyframesFromMoov(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), {
        type: "moov",
        start: headerSize,
        end: boxSize,
      });
    }

    position += boxSize;
  }

  return Option.none<ReadonlyArray<number>>();
});
