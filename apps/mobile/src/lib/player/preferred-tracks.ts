/**
 * The audio and subtitle tracks App Settings asks for (H28 Audio & Subtitles), chosen from what a
 * file has when its playback starts: the preferred audio language (an audio description track when
 * asked for, otherwise not), and subtitles in the preferred language (SDH when asked for).
 */
import type { SubtitleTrack } from "@movies/contracts/media-playback";
import type { AudioStream } from "@movies/contracts/models/catalog";

import { isLanguage } from "../languages";
import type { PlaybackPreferences } from "../preferences";

/** The tracks to switch to; null keeps what the stream chose. */
export interface PreferredTracks {
  readonly audioStreamIndex: number | null;
  readonly subtitleId: string | null;
}

const DESCRIPTION = /audio description|descriptive/iu;

/** `AD` in capitals only, so titles such as `Ad-free mix` do not count. */
const DESCRIPTION_ABBREVIATION = /\bAD\b/u;

/** Whether an audio track's title marks it as audio description. */
const describes = (title: string | null): boolean =>
  title !== null && (DESCRIPTION.test(title) || DESCRIPTION_ABBREVIATION.test(title));

/** The first of `items` ranked by `score`, highest first; ties keep the file's order. */
const best = <A>(items: ReadonlyArray<A>, score: (item: A) => number): A | null =>
  items.reduce<A | null>(
    (chosen, item) => (chosen === null || score(item) > score(chosen) ? item : chosen),
    null,
  );

/** The tracks to play for `preferences` among a file's audio and a stream's subtitles. */
export const preferredTracks = (
  preferences: Pick<
    PlaybackPreferences,
    "audioLanguage" | "audioDescription" | "subtitleLanguage" | "subtitlesSdh"
  >,
  audio: ReadonlyArray<Pick<AudioStream, "index" | "language" | "title" | "default">>,
  subtitles: ReadonlyArray<
    Pick<SubtitleTrack, "id" | "language" | "forced" | "hearingImpaired" | "kind">
  >,
): PreferredTracks => {
  const { audioLanguage, audioDescription, subtitleLanguage, subtitlesSdh } = preferences;
  const fallback = audio.find((track) => track.default) ?? audio[0];

  // Without a preferred language, audio description still applies in the file's own language.
  const audioChoices =
    audioLanguage !== null
      ? audio.filter((track) => isLanguage(track.language, audioLanguage))
      : audioDescription
        ? audio.filter((track) => track.language === fallback?.language)
        : [];

  const audioTrack = best(
    audioChoices,
    (track) => (describes(track.title) === audioDescription ? 2 : 0) + (track.default ? 1 : 0),
  );

  const subtitleTrack =
    subtitleLanguage === null
      ? null
      : best(
          subtitles.filter(
            (track) => !track.forced && isLanguage(track.language, subtitleLanguage),
          ),
          (track) =>
            (track.hearingImpaired === subtitlesSdh ? 2 : 0) + (track.kind === "text" ? 1 : 0),
        );

  return {
    audioStreamIndex: audioTrack?.index ?? null,
    subtitleId: subtitleTrack?.id ?? null,
  };
};
