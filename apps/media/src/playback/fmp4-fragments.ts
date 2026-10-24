/**
 * Reads where an fMP4 fragment file starts and ends. ffmpeg's HLS muxer writes one file per
 * keyframe interval here, each beginning with `styp` and one `sidx` per track; the first `sidx`
 * belongs to the video track and carries the fragment's earliest presentation time and duration.
 */

/** Bytes worth reading from the head of a fragment to find its `sidx`. */
export const FRAGMENT_HEAD_BYTES = 1024;

const readUint64 = (view: DataView, offset: number): number =>
  view.getUint32(offset) * 2 ** 32 + view.getUint32(offset + 4);

/**
 * Where a fragment's video starts and ends, in seconds on the source timeline. ffmpeg's muxer
 * starts each fragment's `sidx` where the previous one ends, so `end` is the next fragment's
 * `start`. `end` is `undefined` when the read head cuts the references off.
 */
export interface FragmentSpan {
  readonly start: number;
  readonly end: number | undefined;
}

const SIDX_REFERENCE_BYTES = 12;

/**
 * The span of the first `sidx` box in `head`: its earliest presentation time, to that time plus
 * the durations of the subsegments it references. `undefined` when `head` does not start with
 * boxes leading to one.
 */
export const fragmentSpan = (head: Uint8Array): FragmentSpan | undefined => {
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  let offset = 0;

  while (offset + 8 <= head.byteLength) {
    const size = view.getUint32(offset);
    const type = String.fromCodePoint(...head.subarray(offset + 4, offset + 8));

    if (size < 8 || type === "moof" || type === "mdat") return undefined;

    if (type === "sidx") {
      const version = head[offset + 8];
      const references = offset + (version === 0 ? 28 : 36);

      if (references > head.byteLength) return undefined;

      const timescale = view.getUint32(offset + 16);
      const earliest = version === 0 ? view.getUint32(offset + 20) : readUint64(view, offset + 20);

      if (timescale === 0) return undefined;
      const start = earliest / timescale;
      const count = references + 4 <= head.byteLength ? view.getUint16(references + 2) : 0;
      const listed = references + 4 + count * SIDX_REFERENCE_BYTES;

      if (count === 0 || listed > Math.min(head.byteLength, offset + size)) {
        return { start, end: undefined };
      }

      let duration = 0;

      for (let index = 0; index < count; index += 1) {
        duration += view.getUint32(references + 4 + index * SIDX_REFERENCE_BYTES + 4);
      }

      return { start, end: (earliest + duration) / timescale };
    }

    offset += size;
  }

  return undefined;
};
