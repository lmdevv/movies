/**
 * Technical badges and track lists for a playable file, from what ffprobe reported: `4K`,
 * `DOLBY VISION`, `HEVC`, `EAC3 5.1`, `CC`, and `English EAC3 5.1, Spanish · English CC`.
 */
import type { HdrFormat, MediaFile } from "@movies/contracts/models/catalog";
import { Match } from "effect";

const resolution = (width: number, height: number): string | null => {
  if (width >= 3200 || height >= 2000) return "4K";

  if (width >= 1800 || height >= 1000) return "1080p";

  if (width >= 1200 || height >= 700) return "720p";

  return null;
};

const hdrLabel = (hdr: HdrFormat): string | null =>
  Match.value(hdr).pipe(
    Match.when("none", () => null),
    Match.when("hdr10", () => "HDR10"),
    Match.when("hdr10plus", () => "HDR10+"),
    Match.when("hlg", () => "HLG"),
    Match.when("dolby_vision", () => "DOLBY VISION"),
    Match.exhaustive,
  );

const CODECS: ReadonlyMap<string, string> = new Map([
  ["hevc", "HEVC"],
  ["h265", "HEVC"],
  ["h264", "H.264"],
  ["avc", "H.264"],
  ["av1", "AV1"],
  ["vp9", "VP9"],
  ["mpeg2video", "MPEG-2"],
]);

const codecLabel = (codec: string): string =>
  CODECS.get(codec.toLowerCase()) ?? codec.toUpperCase();

/** `5.1` for six channels, `7.1` for eight, `2.0` for stereo. */
const channelLabel = (channels: number): string | null => {
  if (channels <= 0) return null;

  if (channels === 1) return "1.0";

  if (channels <= 2) return "2.0";

  return `${channels - 1}.1`;
};

const displayNames = new Intl.DisplayNames(["en"], { type: "language" });

/** `English` for `eng` or `en`; null for unknown or undetermined languages. */
const languageName = (code: string | null): string | null => {
  if (code === null || code === "" || code === "und") return null;

  try {
    const name = displayNames.of(code);

    return name === undefined || name === code ? null : name;
  } catch {
    return null;
  }
};

/** The badges Paper draws after a title's facts, in order: resolution, HDR, codec, audio, CC. */
export const fileBadges = (file: MediaFile): ReadonlyArray<string> => {
  const video = file.probe.video[0];
  const audio = file.probe.audio.find((track) => track.default) ?? file.probe.audio[0];
  const subtitled = file.probe.subtitles.length > 0 || file.externalSubtitles.length > 0;

  const badges = [
    video === undefined ? null : resolution(video.width, video.height),
    video === undefined ? null : hdrLabel(video.hdr),
    video === undefined ? null : codecLabel(video.codec),
    audio === undefined
      ? null
      : [codecLabel(audio.codec), channelLabel(audio.channels)]
          .filter((part) => part !== null)
          .join(" "),
    subtitled ? "CC" : null,
  ];

  return badges.filter((badge): badge is string => badge !== null && badge !== "");
};

/** `English EAC3 5.1, Spanish · English CC, Español`: audio tracks, then subtitle languages. */
export const trackSummary = (file: MediaFile): string | null => {
  const audio = file.probe.audio.map((track) =>
    [
      languageName(track.language) ?? track.title,
      codecLabel(track.codec),
      channelLabel(track.channels),
    ]
      .filter((part) => part !== null && part !== "")
      .join(" "),
  );

  const subtitles = [
    ...file.probe.subtitles.map((track) => languageName(track.language) ?? track.title),
    ...file.externalSubtitles.map((track) => languageName(track.language)),
  ].filter((name): name is string => name !== null && name !== "");

  const parts = [audio.join(", "), [...new Set(subtitles)].join(", ")].filter(
    (part) => part !== "",
  );

  return parts.length === 0 ? null : parts.join(" · ");
};
