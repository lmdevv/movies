/**
 * Where this phone keeps what it remembers between launches: the server, the session tokens, the
 * device ID, and the chosen profile. The keychain, through expo-secure-store, readable once the
 * phone has been unlocked after a restart so background work can reach it.
 */
import type { TokenStorage } from "@movies/sdk/effect";
import * as SecureStore from "expo-secure-store";

const options: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
};

/** The phone's keychain as the SDK's string store. */
export const deviceStore: TokenStorage.KeyValueStore = {
  getItem: (key) => SecureStore.getItemAsync(key, options),
  setItem: (key, value) => SecureStore.setItemAsync(key, value, options),
  removeItem: (key) => SecureStore.deleteItemAsync(key, options),
};
