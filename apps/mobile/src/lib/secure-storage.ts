/**
 * Small values this install keeps between launches, in the iOS keychain through Expo SecureStore:
 * the server it connects to, the SDK's session tokens, the chosen profile, and its device ID.
 * Reads are synchronous so the first screen can decide where to go without a loading frame.
 */
import type { MoviesProviderProps } from "@movies/sdk/react";
import * as SecureStore from "expo-secure-store";

/** Reads `key`, or null when it is unset or the keychain is unavailable. */
export const readValue = (key: string): string | null => {
  try {
    return SecureStore.getItem(key);
  } catch {
    return null;
  }
};

/** Writes `key`, or removes it with null. A keychain failure keeps the value for this launch only. */
export const writeValue = (key: string, value: string | null): void => {
  try {
    if (value === null) void SecureStore.deleteItemAsync(key);
    else SecureStore.setItem(key, value);
  } catch {
    // The keychain can refuse writes while the device is locked; the app keeps working in memory.
  }
};

/** The SDK's session store: the Convex Auth tokens, kept in the keychain. */
export const sessionStore: MoviesProviderProps["storage"] = {
  getItem: (key) => SecureStore.getItemAsync(key),
  setItem: (key, value) => SecureStore.setItemAsync(key, value),
  removeItem: (key) => SecureStore.deleteItemAsync(key),
};
