/**
 * Finds subtitle files stored beside a media file, such as `Movie (2010).en.srt` or
 * `Movie (2010).fre.forced.ass`. Pure: callers pass the names in the media file's folder.
 */
import { Schema } from "effect";

import type { FolderListing } from "./artwork.ts";

/** Text subtitle formats accepted beside media files. */
export const SidecarFormat = Schema.Literals(["srt", "vtt", "ass", "ssa"]);

/** A subtitle file beside a media file. */
export const SidecarSubtitle = Schema.Struct({
  /** Path relative to the library root. */
  path: Schema.String,
  format: SidecarFormat,
  /** ISO 639-2/B code when the name carries a recognised language, such as `eng`. */
  language: Schema.optional(Schema.String),
  /** Name parts that were not a language or a flag, such as `Commentary`. */
  title: Schema.optional(Schema.String),
  forced: Schema.Boolean,
  hearingImpaired: Schema.Boolean,
  default: Schema.Boolean,
});

/** A subtitle file beside a media file. */
export interface SidecarSubtitle extends Schema.Schema.Type<typeof SidecarSubtitle> {}

const FORMATS: ReadonlyMap<string, SidecarSubtitle["format"]> = new Map([
  ["srt", "srt"],
  ["vtt", "vtt"],
  ["ass", "ass"],
  ["ssa", "ssa"],
]);

/** ISO 639-1 codes, ISO 639-2/T variants, and English names mapped to ISO 639-2/B. */
const LANGUAGES: ReadonlyMap<string, string> = new Map(
  (
    [
      ["eng", "en", "english"],
      ["fre", "fr", "fra", "french", "francais"],
      ["ger", "de", "deu", "german", "deutsch"],
      ["spa", "es", "spanish", "espanol"],
      ["ita", "it", "italian"],
      ["por", "pt", "portuguese"],
      ["dut", "nl", "nld", "dutch"],
      ["swe", "sv", "swedish"],
      ["nor", "no", "nb", "nob", "norwegian"],
      ["dan", "da", "danish"],
      ["fin", "fi", "finnish"],
      ["pol", "pl", "polish"],
      ["cze", "cs", "ces", "czech"],
      ["hun", "hu", "hungarian"],
      ["gre", "el", "ell", "greek"],
      ["tur", "tr", "turkish"],
      ["rus", "ru", "russian"],
      ["ukr", "uk", "ukrainian"],
      ["ara", "ar", "arabic"],
      ["heb", "he", "hebrew"],
      ["hin", "hi", "hindi"],
      ["jpn", "ja", "japanese"],
      ["kor", "ko", "korean"],
      ["chi", "zh", "zho", "chinese"],
      ["tha", "th", "thai"],
      ["vie", "vi", "vietnamese"],
      ["ind", "id", "indonesian"],
      ["rum", "ro", "ron", "romanian"],
      ["bul", "bg", "bulgarian"],
      ["hrv", "hr", "croatian"],
      ["srp", "sr", "serbian"],
    ] satisfies ReadonlyArray<readonly [string, ...Array<string>]>
  ).flatMap(([code, ...aliases]) => [code, ...aliases].map((alias) => [alias, code] as const)),
);

const FORCED = new Set(["forced", "foreign"]);

const HEARING_IMPAIRED = new Set(["sdh", "cc", "hi"]);

/** Normalises a language name or code to ISO 639-2/B, or `undefined` when unrecognised. */
export const normaliseLanguage = (value: string): string | undefined =>
  LANGUAGES.get(value.toLowerCase());

/** Subtitle files in `listing` that belong to the media file at `mediaPath`. */
export const sidecarSubtitles = (
  mediaPath: string,
  listing: FolderListing,
): ReadonlyArray<SidecarSubtitle> => {
  const fileName = mediaPath.split("/").at(-1) ?? mediaPath;
  const stem = fileName.replace(/\.[^.]+$/, "").toLowerCase();

  return listing.names.flatMap((name) => {
    const lower = name.toLowerCase();
    const extension = lower.split(".").at(-1) ?? "";
    const format = FORMATS.get(extension);

    if (format === undefined || !lower.startsWith(`${stem}.`)) return [];

    const parts = name
      .slice(stem.length + 1, name.length - extension.length - 1)
      .split(".")
      .filter((part) => part !== "");

    let language: string | undefined;
    const rest: Array<string> = [];

    for (const part of parts) {
      const lowerPart = part.toLowerCase();

      const code =
        HEARING_IMPAIRED.has(lowerPart) || FORCED.has(lowerPart)
          ? undefined
          : normaliseLanguage(part);

      if (language === undefined && code !== undefined) language = code;
      else if (
        !FORCED.has(lowerPart) &&
        !HEARING_IMPAIRED.has(lowerPart) &&
        lowerPart !== "default"
      )
        rest.push(part);
    }

    const flags = new Set(parts.map((part) => part.toLowerCase()));

    return [
      {
        path: listing.folder === "" ? name : `${listing.folder}/${name}`,
        format,
        language,
        title: rest.length === 0 ? undefined : rest.join(" "),
        forced: [...FORCED].some((flag) => flags.has(flag)),
        hearingImpaired: [...HEARING_IMPAIRED].some((flag) => flags.has(flag)),
        default: flags.has("default"),
      },
    ];
  });
};
