import { Effect, Option, Schema } from "effect";

import { LANGUAGES, languageName } from "./languages";
import { QUALITY_OPTIONS as PLAYER_QUALITY_OPTIONS } from "./player/quality";
import type { QualityChoice } from "./player/quality";

const StreamingQuality = Schema.Literals([
  "auto",
  "1080p",
  "720p",
  "480p",
] as const satisfies ReadonlyArray<QualityChoice>);

/** A streaming quality cap. */
export type StreamingQuality = typeof StreamingQuality.Type;

const MobileData = Schema.Literals(["askFirst", "allowStreaming", "wifiOnly"]);

/** A mobile data choice. */
export type MobileData = typeof MobileData.Type;

const LanguageCode = Schema.String.check(Schema.isPattern(/^[a-z]{2}$/u));

/** The playback preferences of this iPhone. */
export interface PlaybackPreferences {
  readonly quality: StreamingQuality;
  readonly mobileData: MobileData;
  /** The audio language to choose when a file has it; null plays the file's default track. */
  readonly audioLanguage: string | null;
  /** The subtitle language to show when a file has it; null leaves subtitles off. */
  readonly subtitleLanguage: string | null;
  /** Prefers subtitles for the deaf and hard of hearing (SDH) in the subtitle language. */
  readonly subtitlesSdh: boolean;
  /** Prefers audio description tracks in the audio language. */
  readonly audioDescription: boolean;
  /** Plays the next episode when one ends, after the next-episode countdown. */
  readonly autoplayNext: boolean;
}

/** Preferences before anyone changed them. */
export const DEFAULT_PREFERENCES: PlaybackPreferences = {
  quality: "auto",
  mobileData: "askFirst",
  audioLanguage: null,
  subtitleLanguage: null,
  subtitlesSdh: false,
  audioDescription: false,
  autoplayNext: true,
};

const orElse = <S extends Schema.Top>(schema: S, fallback: S["Type"]) =>
  Schema.optionalKey(schema.pipe(Schema.catchDecoding(() => Effect.succeedSome(fallback))));

const StoredPreferences = Schema.fromJsonString(
  Schema.Struct({
    quality: orElse(StreamingQuality, DEFAULT_PREFERENCES.quality),
    mobileData: orElse(MobileData, DEFAULT_PREFERENCES.mobileData),
    audioLanguage: orElse(Schema.NullOr(LanguageCode), DEFAULT_PREFERENCES.audioLanguage),
    subtitleLanguage: orElse(Schema.NullOr(LanguageCode), DEFAULT_PREFERENCES.subtitleLanguage),
    subtitlesSdh: orElse(Schema.Boolean, DEFAULT_PREFERENCES.subtitlesSdh),
    audioDescription: orElse(Schema.Boolean, DEFAULT_PREFERENCES.audioDescription),
    autoplayNext: orElse(Schema.Boolean, DEFAULT_PREFERENCES.autoplayNext),
  }),
);

const decodeStored = Schema.decodeUnknownOption(StoredPreferences);

/**
 * The preferences stored as `stored`, from `serializePreferences`. Anything unreadable, including
 * nothing stored yet, reads as the defaults field by field.
 */
export const parsePreferences = (stored: string | null): PlaybackPreferences => ({
  ...DEFAULT_PREFERENCES,
  ...Option.getOrElse(decodeStored(stored), () => ({})),
});

/** The stored form of `preferences`, which `parsePreferences` reads back unchanged. */
export const serializePreferences = (preferences: PlaybackPreferences): string =>
  JSON.stringify(preferences);

/** A row of a preference picker: the value, its label, and an optional muted detail. */
export interface PreferenceOption<A> {
  readonly value: A;
  readonly label: string;
  readonly detail?: string;
}

/** H26: the player's quality menu (F03), with the rate the media service encodes at each height. */
export const QUALITY_OPTIONS: ReadonlyArray<PreferenceOption<StreamingQuality>> =
  PLAYER_QUALITY_OPTIONS.map((option) =>
    option.rate === null
      ? { value: option.id, label: option.label }
      : { value: option.id, label: option.label, detail: option.rate },
  );

/** H27: the mobile data choices. */
export const MOBILE_DATA_OPTIONS: ReadonlyArray<PreferenceOption<MobileData>> = [
  { value: "askFirst", label: "Ask First" },
  { value: "allowStreaming", label: "Allow Streaming" },
  { value: "wifiOnly", label: "Wi-Fi Only" },
];

/** The preferred audio choices: the file's own default, then each language. */
export const AUDIO_OPTIONS: ReadonlyArray<PreferenceOption<string | null>> = [
  { value: null, label: "Original" },
  ...LANGUAGES.map((language) => ({ value: language.code, label: language.name })),
];

/** The subtitle choices: off, then each language. */
export const SUBTITLE_OPTIONS: ReadonlyArray<PreferenceOption<string | null>> = [
  { value: null, label: "Off" },
  ...LANGUAGES.map((language) => ({ value: language.code, label: language.name })),
];

/** The label of `value` among `options`, such as `Ask First`. */
export const optionLabel = <A>(options: ReadonlyArray<PreferenceOption<A>>, value: A): string =>
  options.find((option) => option.value === value)?.label ?? String(value);

/** The preferred audio as App Settings shows it: `Original` or the language, such as `English`. */
export const audioLabel = (preferences: PlaybackPreferences): string =>
  preferences.audioLanguage === null
    ? "Original"
    : (languageName(preferences.audioLanguage) ?? preferences.audioLanguage);

/** The subtitles as App Settings shows them: `Off`, `English`, or `English · SDH`. */
export const subtitlesLabel = (preferences: PlaybackPreferences): string => {
  if (preferences.subtitleLanguage === null) return "Off";

  const name = languageName(preferences.subtitleLanguage) ?? preferences.subtitleLanguage;

  return preferences.subtitlesSdh ? `${name} · SDH` : name;
};
