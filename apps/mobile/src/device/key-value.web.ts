/**
 * The web preview's stand-in for the keychain: `localStorage`, as the web app keeps its session.
 * Only the Expo web preview uses it; the iPhone app uses `key-value.ts`.
 */
import type { TokenStorage } from "@movies/sdk/effect";

/** The browser's `localStorage` as the SDK's string store. */
export const deviceStore: TokenStorage.KeyValueStore = {
  getItem: (key) => window.localStorage.getItem(key),
  setItem: (key, value) => {
    window.localStorage.setItem(key, value);
  },
  removeItem: (key) => {
    window.localStorage.removeItem(key);
  },
};
