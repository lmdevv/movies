/**
 * The client profile a Chromecast negotiates playback with, through the same ladder as any other
 * client. Every Chromecast plays 1080p H.264 (up to level 4.1) with AAC, over fMP4 HLS or as an
 * MP4 file; HEVC, 4K, and HDR are offered only to models that report playing them (Chromecast
 * Ultra, Chromecast with Google TV, Google TV Streamer). The Cast sender SDK reports no codec list,
 * so the model name is the only evidence; an unknown model gets the safe profile.
 */
import type { ClientCapabilities } from "./media-playback";

/** Models that play 4K HDR. */
const UHD_MODEL = /\b(?:ultra|google tv)\b/iu;

const H264_PROFILES = ["Constrained Baseline", "Baseline", "Main", "High"];

const HD_CAPABILITIES: ClientCapabilities = {
  containers: ["mp4"],
  videoCodecs: [{ codec: "h264", profiles: H264_PROFILES, maxLevel: 41, maxBitDepth: 8 }],
  audioCodecs: [
    { codec: "aac", maxChannels: 6 },
    { codec: "mp3", maxChannels: 2 },
  ],
  maxWidth: 1920,
  maxHeight: 1080,
  hls: true,
  mse: false,
};

const UHD_CAPABILITIES: ClientCapabilities = {
  containers: ["mp4"],
  videoCodecs: [
    { codec: "h264", profiles: H264_PROFILES, maxLevel: 51, maxBitDepth: 8 },
    {
      codec: "hevc",
      profiles: ["Main", "Main 10"],
      maxLevel: 153,
      maxBitDepth: 10,
      dynamicRanges: ["hdr10", "hlg"],
    },
  ],
  audioCodecs: HD_CAPABILITIES.audioCodecs,
  maxWidth: 3840,
  maxHeight: 2160,
  hls: true,
  mse: false,
};

/** The profile of a cast device whose model is `modelName`, when the sender SDK reports one. */
export const castCapabilities = (modelName: string | undefined): ClientCapabilities =>
  UHD_MODEL.test(modelName ?? "") ? UHD_CAPABILITIES : HD_CAPABILITIES;
