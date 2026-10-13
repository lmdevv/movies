/**
 * The playback ladder: direct play, then remux to fMP4 HLS, then audio-only transcode, then a
 * hardware (Quick Sync or VA-API) video transcode with tone mapping when needed, then a software
 * transcode capped at 1080p, tone-mapped when this ffmpeg can. A quality cap the viewer chose
 * (`maxHeight`, `maxBitrate`) sends a source above it down the ladder to an encode within it, and
 * an image subtitle (PGS, VobSub) to burn in always means an encode. Pure: it reads a probe, what
 * the client says it can decode, and what the encoders can do.
 */
import type {
  ClientCapabilities,
  PlaybackQuality,
  UnsupportedReason,
} from "@movies/contracts/media-playback";
import type { PlaybackMode } from "@movies/contracts/models/playback";
import { Data } from "effect";

import type { AudioTrack, MediaProbe, VideoStream } from "../media/media-probe.ts";
import type { HardwareEncoder } from "./hardware-acceleration.ts";

/** A video codec the client decodes, with optional limits. */
type VideoCodecSupport = ClientCapabilities["videoCodecs"][number];

/** What happens to the video stream. */
export type VideoPlan = Data.TaggedEnum<{
  Copy: {};
  Encode: {
    readonly encoder: HardwareEncoder | "software";
    readonly width: number;
    readonly height: number;
    /** HDR to SDR conversion. */
    readonly toneMap: boolean;
    readonly bitrate: number;
    /** ffmpeg stream index of an image subtitle drawn onto the picture. */
    readonly burnSubtitle: number | undefined;
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
  /** The GPU encoder transcodes use; software when absent. */
  readonly hardware: HardwareEncoder | undefined;
  /** Whether this ffmpeg can tone-map HDR to SDR in software (`zscale` and `tonemap`). */
  readonly softwareToneMapping: boolean;
  /** The viewer's quality cap; none plays the best the client takes. */
  readonly quality?: PlaybackQuality | undefined;
  /** ffmpeg stream index of an embedded image subtitle to burn into the picture. */
  readonly burnSubtitle?: number | undefined;
  /**
   * Whether the video may be copied (remux, audio-only transcode); false when the session must
   * encode, such as while the file's keyframes are still being indexed. Direct play is unaffected.
   */
  readonly copyVideo?: boolean;
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

/** Whether `probe` exceeds the viewer's cap, so its video must be encoded down. */
const exceeds = (probe: MediaProbe, video: VideoStream, quality: PlaybackQuality | undefined) =>
  quality !== undefined &&
  ((quality.maxHeight !== undefined && video.height > quality.maxHeight) ||
    (quality.maxBitrate !== undefined &&
      probe.bitRate !== undefined &&
      probe.bitRate > quality.maxBitrate));

/**
 * Chooses how to deliver `probe` to `client`. A quality cap that would need an encode this host
 * cannot do (HDR without tone mapping, a client without H.264) is dropped, so the viewer still
 * gets the source rather than nothing; a subtitle to burn in is not, as nothing else shows it.
 */
export const decidePlayback = (
  probe: MediaProbe,
  client: ClientCapabilities,
  options: DecisionOptions,
): PlaybackPlan => {
  const plan = decideWithin(probe, client, options);

  return PlaybackPlan.$is("Unsupported")(plan) && options.quality !== undefined
    ? decideWithin(probe, client, { ...options, quality: undefined })
    : plan;
};

const decideWithin = (
  probe: MediaProbe,
  client: ClientCapabilities,
  options: DecisionOptions,
): PlaybackPlan => {
  const { video } = probe;

  if (video === undefined) return PlaybackPlan.Unsupported({ reason: "no-video-stream" });
  const audio = selectAudio(probe, options.audioIndex);

  if (audio === "missing") return PlaybackPlan.Unsupported({ reason: "audio-track-not-found" });

  const burnSubtitle = options.burnSubtitle;

  if (
    burnSubtitle !== undefined &&
    !probe.subtitles.some((track) => track.index === burnSubtitle && track.kind === "bitmap")
  ) {
    return PlaybackPlan.Unsupported({ reason: "subtitle-not-burnable" });
  }

  const defaultAudio = probe.audio.find((track) => track.default) ?? probe.audio[0];

  // A cap the source exceeds, or a subtitle drawn onto the picture, leaves only an encode.
  const mustEncode = burnSubtitle !== undefined || exceeds(probe, video, options.quality);
  const videoOk = decodesVideo(client, video) && !mustEncode;
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

  if (videoOk && HLS_VIDEO_CODECS.has(canonical(video.codec)) && options.copyVideo !== false) {
    return PlaybackPlan.Hls({
      mode: audioCopyable || audio === undefined ? "remux" : "audio-transcode",
      video: VideoPlan.Copy(),
      audio: audioPlan,
    });
  }

  const h264 = videoSupport(client, "h264");

  if (h264 === undefined) return PlaybackPlan.Unsupported({ reason: "no-transcode-target" });
  const toneMap = video.dynamicRange !== "sdr";
  const encoder = options.hardware ?? "software";

  if (encoder === "software" && toneMap && !options.softwareToneMapping) {
    return PlaybackPlan.Unsupported({ reason: "hdr-tone-mapping-requires-hardware" });
  }

  const capHeight = options.quality?.maxHeight ?? Number.POSITIVE_INFINITY;
  const softwareMax = encoder === "software" ? SOFTWARE_MAX : { width: Infinity, height: Infinity };

  const size = fit(video, {
    width: Math.min(client.maxWidth, softwareMax.width),
    height: Math.min(client.maxHeight, softwareMax.height, capHeight),
  });

  return PlaybackPlan.Hls({
    mode: `transcode-${encoder}`,
    video: VideoPlan.Encode({
      encoder,
      ...size,
      toneMap,
      bitrate: Math.min(
        bitrateFor(size.height),
        options.quality?.maxBitrate ?? Number.POSITIVE_INFINITY,
      ),
      burnSubtitle,
    }),
    audio: audioPlan,
  });
};
