/**
 * What this browser remembers between visits, besides the session tokens the SDK stores: the
 * profile last chosen on it. It lives in `localStorage` and is parsed on read, so a cleared or
 * edited entry falls back to no choice rather than to a malformed id.
 */
import { ProfileId } from "@movies/contracts/ids";
import { Option, Schema } from "effect";

const PROFILE_KEY = "movies.profile";

const decodeProfileId = Schema.decodeUnknownOption(ProfileId);

const read = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

const write = (key: string, value: string | null): void => {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable (private windows, quotas); the choice then lasts for this visit.
  }
};

/** The profile last chosen on this browser, if any. */
export const loadProfileChoice = (): ProfileId | null =>
  Option.getOrNull(decodeProfileId(read(PROFILE_KEY)));

/** Remembers (or forgets, with null) the profile chosen on this browser. */
export const saveProfileChoice = (profileId: ProfileId | null): void => {
  write(PROFILE_KEY, profileId);
};
