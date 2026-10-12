/**
 * The playback ladder: direct play, then remux to fMP4 HLS, then audio-only transcode, then a
 * hardware (QSV) video transcode with tone mapping when needed, then a software transcode capped
 * at 1080p. Pure: it reads a probe, what the client says it can decode, and whether QSV works.
 */
import { Data, Schema } from "effect";

import {
  type AudioTrack,
  Container,
  DynamicRange,
  type MediaProbe,
  type VideoStream,
} from "../media/media-probe.ts";

/** A video codec the client decodes, with optional limits. Names follow ffmpeg (`h264`, `hevc`, `av1`, `vp9`). */
const VideoCodecSupport = Schema.Struct({
  codec: Schema.String,
  /** Accepted ffprobe profile names, such as `High` or `Main 10`; absent accepts any profile. */
  profiles: Schema.optional(Schema.Array(Schema.String)),
  /** Highest level in ffprobe units (41 for H.264 4.1, 153 for HEVC 5.1); absent accepts any level. */
  maxLevel: Schema.optional(Schema.Int),
  /** Highest bit depth; 8 when absent. */
  maxBitDepth: Schema.optional(Schema.Int),
  /** HDR formats the client decodes and displays; SDR is always accepted. */
  dynamicRanges: Schema.optional(Schema.Array(DynamicRange)),
});

/** A video codec the client decodes. */
interface VideoCodecSupport extends Schema.Schema.Type<typeof VideoCodecSupport> {}

/** An audio codec the client decodes. Names follow ffmpeg (`aac`, `ac3`, `eac3`, `opus`, `flac`, `mp3`). */
const AudioCodecSupport = Schema.Struct({
  codec: Schema.String,
  /** Most channels the client plays; 8 when absent. */
  maxChannels: Schema.optional(Schema.Int),
});

/** An audio codec the client decodes. */
interface AudioCodecSupport extends Schema.Schema.Type<typeof AudioCodecSupport> {}

/** What a client can play. Browser checks are hints; a failed direct path renegotiates. */
export const ClientCapabilities = Schema.Struct({
  /** Containers the client plays progressively over byte ranges. */
  containers: Schema.Array(Container),
  videoCodecs: Schema.Array(VideoCodecSupport),
  audioCodecs: Schema.Array(AudioCodecSupport),
  maxWidth: Schema.Int,
  maxHeight: Schema.Int,
  /** Plays HLS natively (Safari, TVs). */
  hls: Schema.Boolean,
  /** Has Media Source Extensions, so a script player (hls.js) can play fMP4 HLS. */
  mse: Schema.Boolean,
});

/** What a client can play. */
export interface ClientCapabilities extends Schema.Schema.Type<typeof ClientCapabilities> {}

/** How a file is delivered. */
export const PlaybackMode = Schema.Literals([
  "direct",
  "remux",
  "audio-transcode",
  "hardware-transcode",
  "software-transcode",
]);

/** How a file is delivered. */
export type PlaybackMode = typeof PlaybackMode.Type;

/** Why no rung of the ladder fits. */
const UnsupportedReason = Schema.Literals([
  "no-video-stream",
  "audio-track-not-found",
  "no-adaptive-streaming",
  "no-transcode-target",
  "hdr-tone-mapping-requires-hardware",
  "unknown-duration",
]);

/** Why no rung of the ladder fits. */
type UnsupportedReason = typeof UnsupportedReason.Type;

/** What happens to the video stream. */
export type VideoPlan = Data.TaggedEnum<{
  Copy: {};
  Encode: {
    readonly encoder: "qsv" | "software";
    readonly width: number;
    readonly height: number;
    /** HDR to SDR conversion, only on QSV. */
    readonly toneMap: boolean;
    readonly bitrate: number;
  };
}>;

/** Constructors and matchers for `VideoPlan`. */
export const VideoPlan = Data.taggedEnum<VideoPlan>();

/** What happens to the selected audio track. */
export type AudioPlan = Data.TaggedEnum<{
  None: {};
  Copy: { readonly index: number };
  /** Stereo AAC LC. */
  Aac: { readonly index: number };
}>;

/** Constructors and matchers for `AudioPlan`. */
export const AudioPlan = Data.taggedEnum<AudioPlan>();

/** The chosen rung. */
export type PlaybackPlan = Data.TaggedEnum<{
  Direct: { readonly audioIndex: number | undefined };
  Hls: {
    readonly mode: Exclude<PlaybackMode, "direct">;
    readonly video: VideoPlan;
    readonly audio: AudioPlan;
  };
  Unsupported: { readonly reason: UnsupportedReason };
}>;

/** Constructors and matchers for `PlaybackPlan`. */
export const PlaybackPlan = Data.taggedEnum<PlaybackPlan>();

/** Inputs besides the probe and the client. */
export interface DecisionOptions {
  /** ffmpeg stream index of the requested audio track; the default track when absent. */
  readonly audioIndex: number | undefined;
  readonly hardwareTranscoding: boolean;
}

const HLS_VIDEO_CODECS: ReadonlySet<string> = new Set(["h264", "hevc", "av1", "vp9"]);

const HLS_AUDIO_CODECS: ReadonlySet<string> = new Set([
  "aac",
  "mp3",
  "ac3",
  "eac3",
  "opus",
  "flac",
  "alac",
]);

const SOFTWARE_MAX = { width: 1920, height: 1080 } as const;

const CODEC_ALIASES: ReadonlyMap<string, string> = new Map([
  ["h265", "hevc"],
  ["avc", "h264"],
  ["avc1", "h264"],
  ["hev1", "hevc"],
  ["hvc1", "hevc"],
  ["vp09", "vp9"],
  ["av01", "av1"],
  ["mp4a", "aac"],
  ["ec-3", "eac3"],
  ["ac-3", "ac3"],
]);

const canonical = (codec: string): string => {
  const lower = codec.toLowerCase();

  return CODEC_ALIASES.get(lower) ?? lower;
};

const videoSupport = (client: ClientCapabilities, codec: string): VideoCodecSupport | undefined =>
  client.videoCodecs.find((support) => canonical(support.codec) === canonical(codec));

/** Whether the client decodes and displays `video` as stored. */
const decodesVideo = (client: ClientCapabilities, video: VideoStream): boolean => {
  const support = videoSupport(client, video.codec);

  if (support === undefined) return false;

  const profileOk =
    support.profiles === undefined ||
    video.profile === undefined ||
    support.profiles.some((profile) => profile.toLowerCase() === video.profile?.toLowerCase());

  const levelOk =
    support.maxLevel === undefined || video.level === undefined || video.level <= support.maxLevel;

  const depthOk = video.bitDepth <= (support.maxBitDepth ?? 8);

  const rangeOk =
    video.dynamicRange === "sdr" || (support.dynamicRanges ?? []).includes(video.dynamicRange);

  const sizeOk = video.width <= client.maxWidth && video.height <= client.maxHeight;

  return profileOk && levelOk && depthOk && rangeOk && sizeOk;
};

const decodesAudio = (client: ClientCapabilities, track: AudioTrack): boolean =>
  client.audioCodecs.some(
    (support) =>
      canonical(support.codec) === canonical(track.codec) &&
      track.channels <= (support.maxChannels ?? 8),
  );

/** Target bitrate in bits per second for an H.264 encode of `height` lines. */
const bitrateFor = (height: number): number =>
  height > 1440
    ? 20_000_000
    : height > 1080
      ? 12_000_000
      : height > 720
        ? 8_000_000
        : height > 480
          ? 4_000_000
          : 2_000_000;

/** Largest even size that fits `bounds` without upscaling or changing the aspect ratio. */
const fit = (video: VideoStream, bounds: { readonly width: number; readonly height: number }) => {
  const scale = Math.min(1, bounds.width / video.width, bounds.height / video.height);
  const even = (value: number) => Math.max(2, Math.floor((value * scale) / 2) * 2);

  return { width: even(video.width), height: even(video.height) };
};

const selectAudio = (
  probe: MediaProbe,
  index: number | undefined,
): AudioTrack | undefined | "missing" => {
  if (index !== undefined) return probe.audio.find((track) => track.index === index) ?? "missing";

  return probe.audio.find((track) => track.default) ?? probe.audio[0];
};

/** Chooses how to deliver `probe` to `client`. */
export const decidePlayback = (
  probe: MediaProbe,
  client: ClientCapabilities,
  options: DecisionOptions,
): PlaybackPlan => {
  const { video } = probe;

  if (video === undefined) return PlaybackPlan.Unsupported({ reason: "no-video-stream" });
  const audio = selectAudio(probe, options.audioIndex);

  if (audio === "missing") return PlaybackPlan.Unsupported({ reason: "audio-track-not-found" });
  const defaultAudio = probe.audio.find((track) => track.default) ?? probe.audio[0];
  const videoOk = decodesVideo(client, video);
  const audioOk = audio === undefined || decodesAudio(client, audio);

  // Browsers play the file's default audio track; another track needs HLS.
  if (
    client.containers.includes(probe.container) &&
    videoOk &&
    audioOk &&
    audio?.index === defaultAudio?.index
  ) {
    return PlaybackPlan.Direct({ audioIndex: audio?.index });
  }

  if (!client.hls && !client.mse)
    return PlaybackPlan.Unsupported({ reason: "no-adaptive-streaming" });

  if (probe.durationSeconds <= 0) return PlaybackPlan.Unsupported({ reason: "unknown-duration" });

  const audioCopyable =
    audio !== undefined && audioOk && HLS_AUDIO_CODECS.has(canonical(audio.codec));

  const audioPlan =
    audio === undefined
      ? AudioPlan.None()
      : audioCopyable
        ? AudioPlan.Copy({ index: audio.index })
        : AudioPlan.Aac({ index: audio.index });

  if (videoOk && HLS_VIDEO_CODECS.has(canonical(video.codec))) {
    return PlaybackPlan.Hls({
      mode: audioCopyable || audio === undefined ? "remux" : "audio-transcode",
      video: VideoPlan.Copy(),
      audio: audioPlan,
    });
  }

  const h264 = videoSupport(client, "h264");

  if (h264 === undefined) return PlaybackPlan.Unsupported({ reason: "no-transcode-target" });
  const toneMap = video.dynamicRange !== "sdr";
  const clientBounds = { width: client.maxWidth, height: client.maxHeight };

  if (options.hardwareTranscoding) {
    const size = fit(video, clientBounds);

    return PlaybackPlan.Hls({
      mode: "hardware-transcode",
      video: VideoPlan.Encode({
        encoder: "qsv",
        ...size,
        toneMap,
        bitrate: bitrateFor(size.height),
      }),
      audio: audioPlan,
    });
  }

  if (toneMap) return PlaybackPlan.Unsupported({ reason: "hdr-tone-mapping-requires-hardware" });

  const size = fit(video, {
    width: Math.min(client.maxWidth, SOFTWARE_MAX.width),
    height: Math.min(client.maxHeight, SOFTWARE_MAX.height),
  });

  return PlaybackPlan.Hls({
    mode: "software-transcode",
    video: VideoPlan.Encode({
      encoder: "software",
      ...size,
      toneMap: false,
      bitrate: bitrateFor(size.height),
    }),
    audio: audioPlan,
  });
};

/** No rung of the playback ladder fits this file and client. */
export class UnsupportedPlayback extends Schema.TaggedError<UnsupportedPlayback>()(
  "UnsupportedPlayback",
  { reason: UnsupportedReason },
  { httpApiStatus: 422 },
) {
  override get message(): string {
    return `Unsupported playback: ${this.reason}`;
  }
}
