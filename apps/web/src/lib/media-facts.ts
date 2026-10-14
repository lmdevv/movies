/**
 * Technical badges and track lists for a playable file, from what ffprobe reported: `4K`,
 * `DOLBY VISION`, `HEVC`, `EAC3 5.1`, `CC`, and `English EAC3 5.1, Spanish · English CC`. The
 * facts themselves are named by the SDK's `MediaLabels`.
 */
import type { SubtitleTrack } from "@movies/contracts/media-playback";
import type { AudioStream, MediaFile } from "@movies/contracts/models/catalog";
import { MediaLabels } from "@movies/sdk/effect";

const { channelLabel, codecLabel, hdrLabel, resolutionLabel } = MediaLabels;

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

/** An audio track as the track chooser lists it: `English 5.1`, or its title, or `Track 2`. */
export const audioTrackLabel = (
  track: Pick<AudioStream, "language" | "title" | "channels">,
  position: number,
): string => {
  const name = languageName(track.language) ?? track.title ?? `Track ${position + 1}`;

  return [name, channelLabel(track.channels)].filter((part) => part !== null).join(" ");
};

/** Image subtitle formats by ffmpeg codec name, as players usually name them. */
const BITMAP_FORMATS = new Map([
  ["hdmv_pgs_subtitle", "PGS"],
  ["dvd_subtitle", "VobSub"],
  ["dvb_subtitle", "DVB"],
]);

/**
 * A subtitle track as the chooser lists it: `English`, `English CC`, `English (Forced)`, or, for an
 * image track that is drawn into the picture, `English (PGS)`, so it never reads like the text
 * track in the same language.
 */
export const subtitleTrackLabel = (
  track: Pick<SubtitleTrack, "language" | "title" | "hearingImpaired" | "forced"> &
    Partial<Pick<SubtitleTrack, "kind" | "codec">>,
  position: number,
): string => {
  const name = languageName(track.language ?? null) ?? track.title ?? `Subtitles ${position + 1}`;

  const base = track.hearingImpaired ? `${name} CC` : track.forced ? `${name} (Forced)` : name;

  if (track.kind !== "bitmap") return base;

  return `${base} (${BITMAP_FORMATS.get(track.codec ?? "") ?? "image"})`;
};

/** The badges Paper draws after a title's facts, in order: resolution, HDR, codec, audio, CC. */
export const fileBadges = (file: MediaFile): ReadonlyArray<string> => {
  const video = file.probe.video[0];
  const audio = file.probe.audio.find((track) => track.default) ?? file.probe.audio[0];
  const subtitled = file.probe.subtitles.length > 0 || file.externalSubtitles.length > 0;

  const badges = [
    video === undefined ? null : resolutionLabel(video.width, video.height),
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
