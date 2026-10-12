/**
 * ffmpeg arguments for one HLS generation. Output keeps the source timeline (`-copyts` with
 * `frag_discont`), so every fragment's `sidx` time matches the session's segment plan, and the
 * HLS muxer starts a new fragment file at every keyframe; the session groups fragments into the
 * planned segments. Transcodes place keyframes on the planned segment starts.
 */
import { AudioPlan, VideoPlan } from "./playback-decision.ts";

/** Everything one ffmpeg run needs; built only from server-side state. */
export interface HlsCommand {
  readonly input: string;
  /** Timestamp of the file's first frame; `-ss` positions are relative to it. */
  readonly sourceStart: number;
  /** First planned segment start this run produces, on the source timeline. */
  readonly from: number;
  readonly videoIndex: number;
  readonly videoCodec: string;
  readonly videoBitDepth: number;
  readonly video: VideoPlan;
  readonly audio: AudioPlan;
  /** ffprobe's name for the source audio track's codec, such as `aac`; empty without audio. */
  readonly audioCodec: string;
  /** Planned segment starts at or after `from`; transcodes force keyframes there. */
  readonly segmentStarts: ReadonlyArray<number>;
  readonly outputDirectory: string;
  readonly qsvDevice: string;
}

/** Codecs the Arc and later Intel media engines decode in hardware. */
const QSV_DECODERS: ReadonlySet<string> = new Set(["h264", "hevc", "av1", "vp9", "mpeg2video"]);

const seconds = (value: number): string => value.toFixed(6);

const videoArgs = (command: HlsCommand): ReadonlyArray<string> =>
  VideoPlan.$match(command.video, {
    Copy: () => ["-c:v", "copy", ...(command.videoCodec === "hevc" ? ["-tag:v", "hvc1"] : [])],
    Encode: ({ encoder, width, height, toneMap, bitrate }) => {
      const keyframes = ["-force_key_frames", command.segmentStarts.map(seconds).join(",")];

      const rate = [
        "-b:v",
        String(bitrate),
        "-maxrate",
        String(bitrate),
        "-bufsize",
        String(bitrate * 2),
      ];

      if (encoder === "software") {
        return [
          "-vf",
          `scale=${width}:${height}:flags=bicubic,format=yuv420p`,
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-profile:v",
          "high",
          "-crf",
          "23",
          "-maxrate",
          String(bitrate),
          "-bufsize",
          String(bitrate * 2),
          ...keyframes,
        ];
      }

      const upload = QSV_DECODERS.has(command.videoCodec)
        ? ""
        : `format=${command.videoBitDepth > 8 ? "p010le" : "nv12"},hwupload=extra_hw_frames=64,`;

      const toneMapping = toneMap
        ? ":tonemap=1:out_color_matrix=bt709:out_color_primaries=bt709:out_color_transfer=bt709"
        : "";

      return [
        "-vf",
        `${upload}vpp_qsv=w=${width}:h=${height}:format=nv12${toneMapping}`,
        "-c:v",
        "h264_qsv",
        "-preset",
        "veryfast",
        ...rate,
        "-forced_idr",
        "1",
        ...keyframes,
      ];
    },
  });

/**
 * Copied AAC from MPEG-TS (and other ADTS sources) carries ADTS headers that MP4 refuses; the
 * filter rewrites them and passes AAC that has none through unchanged.
 */
const copyBitstreamFilter = (codec: string): ReadonlyArray<string> =>
  codec === "aac" ? ["-bsf:a", "aac_adtstoasc"] : [];

const audioArgs = (command: HlsCommand): ReadonlyArray<string> =>
  AudioPlan.$match(command.audio, {
    None: () => ["-an"],
    Copy: ({ index }) => [
      "-map",
      `0:${index}`,
      "-c:a",
      "copy",
      ...copyBitstreamFilter(command.audioCodec),
    ],
    Aac: ({ index }) => ["-map", `0:${index}`, "-c:a", "aac", "-ac", "2", "-b:a", "192k"],
  });

const hardwareInput = (command: HlsCommand): ReadonlyArray<string> => {
  const usesQsv = VideoPlan.$is("Encode")(command.video) && command.video.encoder === "qsv";

  if (!usesQsv) return [];
  const device = ["-init_hw_device", `qsv=hw:${command.qsvDevice}`, "-filter_hw_device", "hw"];

  return QSV_DECODERS.has(command.videoCodec)
    ? [...device, "-hwaccel", "qsv", "-hwaccel_output_format", "qsv"]
    : device;
};

/** The full ffmpeg argument list for `command`. */
export const hlsCommandArgs = (command: HlsCommand): ReadonlyArray<string> => {
  const offset = command.from - command.sourceStart;

  return [
    "-hide_banner",
    "-nostdin",
    "-nostats",
    "-v",
    "error",
    ...hardwareInput(command),
    ...(offset > 0.001 ? ["-ss", seconds(offset)] : []),
    "-copyts",
    "-i",
    command.input,
    "-map",
    `0:${command.videoIndex}`,
    ...audioArgs(command),
    ...videoArgs(command),
    "-map_metadata",
    "-1",
    "-map_chapters",
    "-1",
    "-sn",
    "-dn",
    "-max_muxing_queue_size",
    "4096",
    "-f",
    "hls",
    "-hls_time",
    "0.1",
    "-hls_list_size",
    "0",
    "-hls_playlist_type",
    "event",
    "-hls_segment_type",
    "fmp4",
    "-hls_flags",
    "temp_file",
    "-hls_fmp4_init_filename",
    "init.mp4",
    "-hls_segment_options",
    "movflags=+frag_discont",
    "-start_number",
    "0",
    "-hls_segment_filename",
    `${command.outputDirectory}/f%d.m4s`,
    `${command.outputDirectory}/ffmpeg.m3u8`,
  ];
};
