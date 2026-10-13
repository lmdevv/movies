/**
 * ffmpeg arguments for one HLS generation. Output keeps the source timeline (`-copyts` with
 * `frag_discont`), so every fragment's `sidx` time matches the session's segment plan, and the
 * HLS muxer starts a new fragment file at every keyframe; the session groups fragments into the
 * planned segments. Transcodes place keyframes on the planned segment starts. Encodes run in
 * software (libx264), on Intel Quick Sync, or through VA-API (Intel and AMD); a GPU decodes the
 * source itself when it can, and tone-maps HDR to SDR (`vpp_qsv`, `tonemap_vaapi`), as does the
 * software path with `zscale`.
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
  /** ffprobe's name for the burned-in subtitle's codec, such as `dvd_subtitle`; empty without. */
  readonly subtitleCodec: string;
  /** Planned segment starts at or after `from`; transcodes force keyframes there. */
  readonly segmentStarts: ReadonlyArray<number>;
  readonly outputDirectory: string;
  readonly qsvDevice: string;
  readonly vaapiDevice: string;
}

/** Codecs Intel (Quick Sync, VA-API) and AMD (VA-API) media engines decode in hardware. */
const HARDWARE_DECODERS: ReadonlySet<string> = new Set([
  "h264",
  "hevc",
  "av1",
  "vp9",
  "mpeg2video",
]);

/**
 * HDR to SDR in software: linearize, map with Hable onto 100 nits, convert to BT.709. Needs
 * ffmpeg's `zscale` (libzimg) and `tonemap`; negotiation checks for them first.
 */
const SOFTWARE_TONE_MAP =
  "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv";

const seconds = (value: number): string => value.toFixed(6);

type Encode = Extract<VideoPlan, { readonly _tag: "Encode" }>;

/** A one-input chain for `-vf`, or a graph with the subtitle input for `-filter_complex`. */
interface FilterGraph {
  readonly kind: "simple" | "complex";
  readonly graph: string;
}

/** Whether the source decodes on the GPU straight into the encoder's filters. */
const decodesOnGpu = (command: HlsCommand, video: Encode): boolean =>
  video.encoder !== "software" && HARDWARE_DECODERS.has(command.videoCodec);

/** Filters from frames in system memory to frames the GPU encoder takes, scaled to the target. */
const gpuFilters = (command: HlsCommand, video: Encode, uploaded: boolean): string => {
  const size = `w=${String(video.width)}:h=${String(video.height)}`;

  const upload = uploaded
    ? ""
    : `format=${command.videoBitDepth > 8 ? "p010le" : "nv12"},hwupload${video.encoder === "qsv" ? "=extra_hw_frames=64" : ""},`;

  if (video.encoder === "qsv") {
    const toneMapping = video.toneMap
      ? ":tonemap=1:out_color_matrix=bt709:out_color_primaries=bt709:out_color_transfer=bt709"
      : "";

    return `${upload}vpp_qsv=${size}:format=nv12${toneMapping}`;
  }

  const toneMapping = video.toneMap ? "tonemap_vaapi=format=nv12:p=bt709:t=bt709:m=bt709," : "";

  return `${upload}${toneMapping}scale_vaapi=${size}:format=nv12`;
};

/**
 * The video filter graph: scale and tone-map on the CPU or the GPU. An image subtitle is drawn
 * on the finished SDR picture at the output size, after tone mapping (subtitles are SDR): in
 * software straight away, on a GPU after downloading its frames, which are then uploaded again
 * for the encoder. The subtitle's canvas (720x576 for DVD) is scaled to the picture it covers.
 */
const videoFilters = (command: HlsCommand, video: Encode): FilterGraph => {
  const width = String(video.width);
  const height = String(video.height);

  const picture =
    video.encoder === "software"
      ? [
          `scale=${width}:${height}:flags=bicubic`,
          ...(video.toneMap ? [SOFTWARE_TONE_MAP] : []),
        ].join(",")
      : gpuFilters(command, video, decodesOnGpu(command, video));

  if (video.burnSubtitle === undefined) {
    return {
      kind: "simple",
      graph: video.encoder === "software" ? `${picture},format=yuv420p` : picture,
    };
  }

  const subtitleInput = subtitleReading(command).second ? "1" : "0";

  const [download, upload] =
    video.encoder === "software"
      ? ["", "format=yuv420p"]
      : [
          ",hwdownload,format=nv12",
          `format=nv12,hwupload${video.encoder === "qsv" ? "=extra_hw_frames=64,format=qsv" : ""}`,
        ];

  return {
    kind: "complex",
    graph: [
      `[0:${String(command.videoIndex)}]${picture}${download}[picture]`,
      `[${subtitleInput}:${String(video.burnSubtitle)}]scale=${width}:${height}[subtitle]`,
      `[picture][subtitle]overlay=eof_action=pass:repeatlast=0,${upload}[video]`,
    ].join(";"),
  };
};

const videoArgs = (command: HlsCommand): ReadonlyArray<string> =>
  VideoPlan.$match(command.video, {
    Copy: () => [
      "-map",
      `0:${String(command.videoIndex)}`,
      "-c:v",
      "copy",
      ...(command.videoCodec === "hevc" ? ["-tag:v", "hvc1"] : []),
    ],
    Encode: (video) => {
      const keyframes = ["-force_key_frames", command.segmentStarts.map(seconds).join(",")];
      const rate = String(video.bitrate);
      const filters = videoFilters(command, video);

      const graph =
        filters.kind === "simple"
          ? ["-map", `0:${String(command.videoIndex)}`, "-vf", filters.graph]
          : ["-filter_complex", filters.graph, "-map", "[video]"];

      if (video.encoder === "software") {
        return [
          ...graph,
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-profile:v",
          "high",
          "-crf",
          "23",
          "-maxrate",
          rate,
          "-bufsize",
          String(video.bitrate * 2),
          ...keyframes,
        ];
      }

      const bitrate = ["-b:v", rate, "-maxrate", rate, "-bufsize", String(video.bitrate * 2)];

      return video.encoder === "qsv"
        ? [
            ...graph,
            "-c:v",
            "h264_qsv",
            "-preset",
            "veryfast",
            ...bitrate,
            "-forced_idr",
            "1",
            ...keyframes,
          ]
        : [...graph, "-c:v", "h264_vaapi", "-profile:v", "high", ...bitrate, ...keyframes];
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
  const video = command.video;

  if (!VideoPlan.$is("Encode")(video) || video.encoder === "software") return [];
  const onGpu = decodesOnGpu(command, video);

  if (video.encoder === "qsv") {
    return [
      "-init_hw_device",
      `qsv=hw:${command.qsvDevice}`,
      "-filter_hw_device",
      "hw",
      ...(onGpu ? ["-hwaccel", "qsv", "-hwaccel_output_format", "qsv"] : []),
    ];
  }

  return [
    "-init_hw_device",
    `vaapi=va:${command.vaapiDevice}`,
    "-filter_hw_device",
    "va",
    ...(onGpu
      ? ["-hwaccel", "vaapi", "-hwaccel_output_format", "vaapi", "-hwaccel_device", "va"]
      : []),
  ];
};

/**
 * Subtitles that started before the seek point are still on screen there, but a seek skips
 * their packets. A burned-in subtitle therefore comes from a second reading of the file, from
 * `SUBTITLE_LEAD` earlier; timestamps line up through `-copyts`. A run from the start reads once.
 */
const SUBTITLE_LEAD = 30;

/** DVD subtitles carry no canvas size; without one ffmpeg sizes them to the video and crops. */
const DVD_CANVAS = "720x576";

/** How a burned-in subtitle is read: its canvas size, and whether from a second reading. */
const subtitleReading = (command: HlsCommand) => {
  const video = command.video;
  const burning = VideoPlan.$is("Encode")(video) && video.burnSubtitle !== undefined;
  const offset = command.from - command.sourceStart;

  return {
    canvas: burning && command.subtitleCodec === "dvd_subtitle" ? ["-canvas_size", DVD_CANVAS] : [],
    second: burning && offset > 0.001,
    lead: Math.max(0, offset - SUBTITLE_LEAD),
  };
};

/** The full ffmpeg argument list for `command`. */
export const hlsCommandArgs = (command: HlsCommand): ReadonlyArray<string> => {
  const offset = command.from - command.sourceStart;
  const subtitles = subtitleReading(command);

  return [
    "-hide_banner",
    "-nostdin",
    "-nostats",
    "-v",
    "error",
    ...hardwareInput(command),
    // A canvas size applies to the input it precedes: the subtitle's, which is this one from 0 s.
    ...(subtitles.second ? [] : subtitles.canvas),
    ...(offset > 0.001 ? ["-ss", seconds(offset)] : []),
    "-copyts",
    "-i",
    command.input,
    ...(subtitles.second
      ? [
          ...subtitles.canvas,
          ...(subtitles.lead > 0.001 ? ["-ss", seconds(subtitles.lead)] : []),
          "-copyts",
          "-i",
          command.input,
        ]
      : []),
    ...videoArgs(command),
    ...audioArgs(command),
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
