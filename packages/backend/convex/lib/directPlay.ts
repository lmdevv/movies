import type { Doc } from "../_generated/dataModel";

type DynamicRange = "sdr" | "hdr10" | "hlg" | "dolby-vision";

/**
 * What a client can play: `clientCapabilities` as `playback.createSession` receives it, read-only
 * so the contracts' `ClientCapabilities` fits too.
 */
export interface ClientCapabilities {
  readonly containers: ReadonlyArray<string>;
  readonly videoCodecs: ReadonlyArray<{
    readonly codec: string;
    readonly profiles?: ReadonlyArray<string> | undefined;
    readonly maxLevel?: number | undefined;
    readonly maxBitDepth?: number | undefined;
    readonly dynamicRanges?: ReadonlyArray<DynamicRange> | undefined;
  }>;
  readonly audioCodecs: ReadonlyArray<{
    readonly codec: string;
    readonly maxChannels?: number | undefined;
  }>;
  readonly maxWidth: number;
  readonly maxHeight: number;
}

/** A video stream as direct play reads it. */
export interface DirectPlayVideo {
  readonly codec: string;
  readonly profile?: string | undefined;
  readonly level?: number | undefined;
  readonly bitDepth: number;
  readonly width: number;
  readonly height: number;
  readonly dynamicRange: DynamicRange;
}

/** A file's container, video, and default audio track as direct play reads them. */
export interface DirectPlayFile {
  readonly container: string;
  readonly video: DirectPlayVideo | undefined;
  readonly audio: { readonly codec: string; readonly channels: number } | undefined;
}

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

const canonicalCodec = (codec: string): string => {
  const lower = codec.toLowerCase();

  return CODEC_ALIASES.get(lower) ?? lower;
};

const decodesVideo = (client: ClientCapabilities, video: DirectPlayVideo): boolean => {
  const support = client.videoCodecs.find(
    (candidate) => canonicalCodec(candidate.codec) === canonicalCodec(video.codec),
  );

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

/** Whether the client plays `file` as stored; mirrors `playsDirectly` in contracts. */
export const playsDirectly = (client: ClientCapabilities, file: DirectPlayFile): boolean =>
  client.containers.some((container) => container === file.container) &&
  file.video !== undefined &&
  decodesVideo(client, file.video) &&
  (file.audio === undefined ||
    client.audioCodecs.some(
      (support) =>
        file.audio !== undefined &&
        canonicalCodec(support.codec) === canonicalCodec(file.audio.codec) &&
        file.audio.channels <= (support.maxChannels ?? 8),
    ));

const DYNAMIC_RANGES: Readonly<
  Record<Doc<"mediaFiles">["probe"]["video"][number]["hdr"], DynamicRange>
> = {
  none: "sdr",
  hdr10: "hdr10",
  hdr10plus: "hdr10",
  hlg: "hlg",
  dolby_vision: "dolby-vision",
};

/** A stored file as direct play reads it: its primary video and default audio track. */
export const directPlayFile = (file: Doc<"mediaFiles">): DirectPlayFile => {
  const video = file.probe.video[0];
  const audio = file.probe.audio.find((track) => track.default) ?? file.probe.audio[0];

  return {
    container: file.probe.container,
    video:
      video === undefined
        ? undefined
        : {
            codec: video.codec,
            profile: video.profile ?? undefined,
            level: video.level,
            bitDepth: video.bitDepth ?? 8,
            width: video.width,
            height: video.height,
            dynamicRange: DYNAMIC_RANGES[video.hdr],
          },
    audio: audio === undefined ? undefined : { codec: audio.codec, channels: audio.channels },
  };
};
