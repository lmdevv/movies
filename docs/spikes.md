# Spikes

Results of first-week spikes. Each section records what was tried, what was measured, and the
decision it led to.

## Effect HttpApi media serving

Question: can Effect 4.0.3 (`effect/http`, `effect/http-api`, `@effect/platform-node` 4.0.3) on
Node 24 serve media bytes correctly, or do media bytes need raw Node handlers?

Verdict: **Effect serves media bytes correctly.** The media service keeps one Effect server:
HttpApi for the control endpoints (`/api/...`) and `HttpRouter` routes for bytes (`/media/...`),
which `<video>` elements and HLS players fetch by URL. No raw Node fallback is needed.

Measured on the owner's box (Node 24.20, localhost, warm page cache, 2026-10-12).

### Byte ranges

- `HttpServerResponse.file(path, { status: 206, offset, bytesToRead })` streams through
  `fs.createReadStream({ start, end })` and `stream.pipeline` into the socket. Nothing buffers
  the whole file: serving a 256 MiB file to a reader that pulls slowly kept RSS flat.
- 206 with the right `Content-Range`, suffix ranges (`bytes=-N`), and 416 with
  `Content-Range: bytes */size` all behave as RFC 9110 requires; returned bytes match the file.
- Client disconnects: `NodeHttpServer` interrupts the request fiber when the response closes
  early, which aborts the pipeline and destroys the read stream. After 50 aborts mid-body, open
  file descriptors returned to the baseline.
- Time to first byte for a 1 MiB range at offset 128 MiB of a 256 MiB file: 0.83–0.99 ms over
  five runs. A full 256 MiB response took 0.265 s.
- Gaps found and handled in the service: the Node platform adds a weak `ETag`, which cannot
  satisfy `If-Range`, so direct play sets its own strong validator; the router has no `HEAD`
  method, so the direct route is registered for `*` and checks the method (Node then sends
  headers only); Effect's server spans record `url.full` and `url.query`, which would leak
  playback tokens, so built-in spans are disabled for `/media/` and those routes record their own.

### HLS segments as they are produced

ffmpeg writes fMP4 HLS with `-hls_flags temp_file`, so a fragment file appears only when it is
complete; the service serves each one as soon as it exists.

| Path (30 s 1080p H.264 source)                              | Time to first segment |
| ----------------------------------------------------------- | --------------------- |
| Remux (`-c copy`)                                           | 149 ms                |
| libx264 `veryfast`                                          | 1.18 s                |
| Intel QSV `h264_qsv`, hardware decode and encode (Arc A380) | 665 ms                |

QSV encoded the whole 30 s clip in 1.63 s (about 18× real time).

Findings that shaped the stream design:

- Seeks restart ffmpeg at the requested segment. To keep every generation on the source
  timeline, the service uses `-copyts` with `-hls_segment_options movflags=+frag_discont`;
  without `frag_discont` a restarted run resets `tfdt` to 0, and `-output_ts_offset` alone did
  the same in fMP4 HLS.
- `-hls_time` cuts on a running grid from the run's first packet, so a restarted copy run cuts
  differently from the first run. The service instead asks ffmpeg for one fragment per keyframe
  (`-hls_time 0.1`) and groups fragments into planned segments by the `sidx` presentation time.
- `-force_key_frames expr:gte(t,n_forced*4)` skipped a keyframe under `-copyts`; an explicit list
  of segment start times is exact.
- Copy-mode segment plans need source keyframe times. An ffprobe packet scan reads the whole
  file (8.8 s for a 1.9 GB MKV on the HDD, about 220 MB/s). Reading the Matroska Cues index
  found the same 3,722 keyframes in 19 ms with 15 reads (144 KB). Other containers fall back to
  the scan once and cache the result.

### Intel QSV on the Arc A380

- The default nixpkgs `ffmpeg` 9.0.1 is built with `--disable-libvpl`: VAAPI encoders exist,
  QSV encoders do not. nixpkgs `ffmpeg-full` 9.0.1 (a 77 MiB download from the binary cache)
  has `h264_qsv`, `hevc_qsv`, `av1_qsv`, `vp9_qsv`, and `vpp_qsv`, and loads the iHD driver from
  `/run/opengl-driver`. The dev shell now uses `ffmpeg-full`.
- Verified for real: QSV H.264 encode, hardware decode of H.264 and HEVC Main 10, and
  `vpp_qsv=tonemap=1` turning HDR10 HEVC into BT.709 H.264 (an end-to-end test runs when a QSV
  test encode succeeds; CI has no GPU and skips it).
- A failing QSV run (for example a missing render node) falls back to software when the ladder
  allows it and reports the mode change; this path is tested everywhere.
