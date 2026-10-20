/**
 * What a download of a file becomes, by the playback ladder (`decidePlayback`) for a client that
 * opens local MP4 and QuickTime files: the original file when the device plays it as it is within
 * the chosen quality, else an MP4 with the video copied (a remux, or only the audio converted),
 * else one with the video encoded to H.264 in software. Pure: it reads a probe, what the client
 * decodes, and what this ffmpeg can do.
 */
import type {
  ClientCapabilities,
  DownloadQuality,
  PlaybackQuality,
  UnsupportedReason,
} from "@movies/contracts/media-playback";
import type { PlaybackMode } from "@movies/contracts/models/playback";
import { Data } from "effect";

import type { MediaProbe } from "../media/media-probe.ts";
import {
  AudioPlan,
  type AudioPlan as AudioPlanType,
  decidePlayback,
  PlaybackPlan,
  VideoPlan,
  type VideoPlan as VideoPlanType,
} from "../playback/playback-decision.ts";

/**
 * The cap of each download quality: the players' 720p and 1080p presets, so `standard` is the
 * stream a 720p choice plays.
 */
const DOWNLOAD_CAPS: Readonly<Record<DownloadQuality, PlaybackQuality>> = {
  standard: { maxHeight: 720, maxBitrate: 4_000_000 },
  high: { maxHeight: 1080, maxBitrate: 10_000_000 },
};

/** Containers a device opens as local files; anything else becomes an MP4. */
const FILE_CONTAINERS: ReadonlySet<string> = new Set(["mp4", "mov"]);

/** Bits per second of the stereo AAC an encode writes (`AudioPlan.Aac`). */
const AAC_BITRATE = 192_000;

/** What a download is. */
export type DownloadPlan = Data.TaggedEnum<{
  /** The file as it is on disk. */
  Original: {};
  /** An MP4 the media service writes once: the video copied or encoded, the audio planned. */
  Mp4: {
    readonly mode: Exclude<PlaybackMode, "direct">;
    readonly video: VideoPlanType;
    readonly audio: AudioPlanType;
    /** An upper bound on the MP4's size, for space checks before it exists. */
    readonly estimatedBytes: number;
  };
  Unsupported: { readonly reason: UnsupportedReason };
}>;

/** Constructors and matchers for `DownloadPlan`. */
export const DownloadPlan = Data.taggedEnum<DownloadPlan>();

/** Inputs besides the probe, the client, and the quality. */
export interface DownloadOptions {
  /** ffmpeg stream index of the audio track to keep; the default track when absent. */
  readonly audioIndex: number | undefined;
  /** Whether this ffmpeg can tone-map HDR to SDR in software. */
  readonly softwareToneMapping: boolean;
  /** The source file's size on disk. */
  readonly sizeBytes: number;
}

/**
 * Chooses what `client` downloads of `probe` at `quality`. A file another audio track was asked
 * for, or in a container the device cannot open, is written as an MP4 even when its streams play
 * as they are. Encodes run in software: a download waits for no player, and the GPU stays free for
 * streams.
 */
export const decideDownload = (
  probe: MediaProbe,
  client: ClientCapabilities,
  quality: DownloadQuality,
  options: DownloadOptions,
): DownloadPlan => {
  const plan = decidePlayback(
    probe,
    {
      containers: client.containers.filter((container) => FILE_CONTAINERS.has(container)),
      videoCodecs: client.videoCodecs,
      audioCodecs: client.audioCodecs,
      maxWidth: client.maxWidth,
      maxHeight: client.maxHeight,
      // Anything not played as it is goes through the ladder's HLS rungs, written here as an MP4.
      hls: true,
      mse: false,
    },
    {
      audioIndex: options.audioIndex,
      hardware: undefined,
      softwareToneMapping: options.softwareToneMapping,
      quality: DOWNLOAD_CAPS[quality],
    },
  );

  return PlaybackPlan.$match(plan, {
    Direct: () => DownloadPlan.Original(),
    Unsupported: ({ reason }) => DownloadPlan.Unsupported({ reason }),
    Hls: ({ mode, video, audio }) => {
      const audioBits = AudioPlan.$is("Aac")(audio) ? AAC_BITRATE : 0;

      const estimatedBytes = VideoPlan.$match(video, {
        // A copy holds the source's streams; converted audio adds at most its own rate.
        Copy: () => options.sizeBytes + (audioBits * probe.durationSeconds) / 8,
        Encode: ({ bitrate }) => ((bitrate + AAC_BITRATE) * probe.durationSeconds) / 8,
      });

      return DownloadPlan.Mp4({ mode, video, audio, estimatedBytes: Math.ceil(estimatedBytes) });
    },
  });
};
