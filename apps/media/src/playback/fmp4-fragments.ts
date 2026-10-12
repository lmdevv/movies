/**
 * Reads where an fMP4 fragment file starts. ffmpeg's HLS muxer writes one file per keyframe
 * interval here, each beginning with `styp` and one `sidx` per track; the first `sidx` belongs to
 * the video track and carries the fragment's earliest presentation time.
 */

/** Bytes worth reading from the head of a fragment to find its `sidx`. */
export const FRAGMENT_HEAD_BYTES = 1024;

const readUint64 = (view: DataView, offset: number): number =>
  view.getUint32(offset) * 2 ** 32 + view.getUint32(offset + 4);

/**
 * The earliest presentation time, in seconds, of the first `sidx` box in `head`, or `undefined`
 * when `head` does not start with boxes containing one.
 */
export const fragmentStartSeconds = (head: Uint8Array): number | undefined => {
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  let offset = 0;

  while (offset + 8 <= head.byteLength) {
    const size = view.getUint32(offset);
    const type = String.fromCodePoint(...head.subarray(offset + 4, offset + 8));

    if (type === "sidx" && offset + 32 <= head.byteLength) {
      const version = head[offset + 8];
      const timescale = view.getUint32(offset + 16);
      const earliest = version === 0 ? view.getUint32(offset + 20) : readUint64(view, offset + 20);

      return timescale > 0 ? earliest / timescale : undefined;
    }

    if (size < 8 || type === "moof" || type === "mdat") return undefined;
    offset += size;
  }

  return undefined;
};
