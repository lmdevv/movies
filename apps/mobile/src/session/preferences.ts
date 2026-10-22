import { useSyncExternalStore } from "react";

import { loadAppearance, saveAppearance } from "@/lib/appearance";
import type { Appearance } from "@/lib/appearance";
import { parsePreferences, serializePreferences } from "@/lib/preferences";
import type { PlaybackPreferences } from "@/lib/preferences";
import { readValue, writeValue } from "@/lib/secure-storage";

const KEY = "movies.preferences";

/** Every preference App Settings shows. */
export interface AppPreferences extends PlaybackPreferences {
  readonly appearance: Appearance;
}

let current: AppPreferences = {
  appearance: loadAppearance(),
  ...parsePreferences(readValue(KEY)),
};

const listeners = new Set<() => void>();

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
};

const read = (): AppPreferences => current;

/** Changes some preferences, keeps them in the keychain, and applies a new appearance at once. */
export const updatePreferences = (change: Partial<AppPreferences>): void => {
  const { appearance, ...playback } = { ...current, ...change };

  if (appearance !== current.appearance) saveAppearance(appearance);

  writeValue(KEY, serializePreferences(playback));
  current = { appearance, ...playback };

  for (const listener of listeners) listener();
};

/**
 * Every preference, re-rendering when one changes. The player reads the playback ones (quality,
 * mobile data, languages, audio description, autoplay) from here when it starts.
 */
export const usePreferences = (): AppPreferences => useSyncExternalStore(subscribe, read, read);
