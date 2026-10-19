import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { LANGUAGES, isLanguage, languageName } from "./languages";
import {
  AUDIO_OPTIONS,
  DEFAULT_PREFERENCES,
  MOBILE_DATA_OPTIONS,
  QUALITY_OPTIONS,
  audioLabel,
  optionLabel,
  parsePreferences,
  serializePreferences,
  subtitlesLabel,
} from "./preferences";
import type { PlaybackPreferences } from "./preferences";

const language = fc.constantFrom(...LANGUAGES.map((each) => each.code));

const preferences: fc.Arbitrary<PlaybackPreferences> = fc.record({
  quality: fc.constantFrom(...QUALITY_OPTIONS.map((option) => option.value)),
  mobileData: fc.constantFrom(...MOBILE_DATA_OPTIONS.map((option) => option.value)),
  audioLanguage: fc.option(language, { nil: null }),
  subtitleLanguage: fc.option(language, { nil: null }),
  subtitlesSdh: fc.boolean(),
  audioDescription: fc.boolean(),
  autoplayNext: fc.boolean(),
});

describe("preferences", () => {
  it("reads back what it stored", () => {
    fc.assert(
      fc.property(preferences, (stored) => {
        expect(parsePreferences(serializePreferences(stored))).toEqual(stored);
      }),
    );
  });

  it("reads nothing, or anything unreadable, as the defaults", () => {
    expect(parsePreferences(null)).toEqual(DEFAULT_PREFERENCES);
    expect(parsePreferences("not json")).toEqual(DEFAULT_PREFERENCES);
    expect(parsePreferences("[1,2]")).toEqual(DEFAULT_PREFERENCES);
    fc.assert(
      fc.property(fc.string(), (stored) => {
        const parsed = parsePreferences(stored);

        expect(Object.keys(parsed).toSorted()).toEqual(Object.keys(DEFAULT_PREFERENCES).toSorted());
      }),
    );
  });

  it("keeps each valid field when another is not", () => {
    expect(
      parsePreferences(
        JSON.stringify({ quality: "720p", mobileData: "sometimes", audioLanguage: "English" }),
      ),
    ).toEqual({ ...DEFAULT_PREFERENCES, quality: "720p" });
  });

  it("labels the choices as App Settings shows them", () => {
    expect(optionLabel(MOBILE_DATA_OPTIONS, "wifiOnly")).toBe("Wi-Fi Only");
    expect(optionLabel(AUDIO_OPTIONS, null)).toBe("Original");
    expect(audioLabel(DEFAULT_PREFERENCES)).toBe("Original");
    expect(audioLabel({ ...DEFAULT_PREFERENCES, audioLanguage: "es" })).toBe("Español");
    expect(subtitlesLabel(DEFAULT_PREFERENCES)).toBe("Off");
    expect(
      subtitlesLabel({ ...DEFAULT_PREFERENCES, subtitleLanguage: "en", subtitlesSdh: true }),
    ).toBe("English · SDH");
    expect(subtitlesLabel({ ...DEFAULT_PREFERENCES, subtitleLanguage: "ja" })).toBe("日本語");
  });
});

describe("languages", () => {
  it("matches track tags in either ISO code and with a region", () => {
    expect(isLanguage("eng", "en")).toBe(true);
    expect(isLanguage("en-US", "en")).toBe(true);
    expect(isLanguage("fre", "fr")).toBe(true);
    expect(isLanguage("fra", "fr")).toBe(true);
    expect(isLanguage("nb", "no")).toBe(true);
    expect(isLanguage("iw", "he")).toBe(true);
    expect(isLanguage("in-ID", "id")).toBe(true);
    expect(isLanguage("spa", "en")).toBe(false);
    expect(isLanguage("und", "en")).toBe(false);
    expect(isLanguage(null, "en")).toBe(false);
  });

  it("matches every listed code to itself and names it", () => {
    for (const each of LANGUAGES) {
      expect(isLanguage(each.code, each.code)).toBe(true);

      for (const other of each.others) expect(isLanguage(other, each.code)).toBe(true);
      expect(languageName(each.code)).toBe(each.name);
    }

    expect(languageName("xx")).toBe("XX");
  });
});
