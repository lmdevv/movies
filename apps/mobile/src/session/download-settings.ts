import { useSyncExternalStore } from "react";

import { parseDownloadSettings, serializeDownloadSettings } from "@/lib/downloads/settings";
import type { DownloadSettings } from "@/lib/downloads/settings";
import { readValue, writeValue } from "@/lib/secure-storage";

const KEY = "movies.downloads.settings";

let current: DownloadSettings = parseDownloadSettings(readValue(KEY));

const listeners = new Set<() => void>();

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
};

const read = (): DownloadSettings => current;

/** Changes some settings and keeps them in the keychain. */
export const updateDownloadSettings = (change: Partial<DownloadSettings>): void => {
  current = {
    wifiOnly: change.wifiOnly ?? current.wifiOnly,
    quality: change.quality ?? current.quality,
  };
  writeValue(KEY, serializeDownloadSettings(current));

  for (const listener of listeners) listener();
};

/** Download Settings, re-rendering when they change. */
export const useDownloadSettings = (): DownloadSettings =>
  useSyncExternalStore(subscribe, read, read);
