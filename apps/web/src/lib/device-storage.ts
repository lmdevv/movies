/**
 * What this browser remembers between visits, besides the session tokens the SDK stores: the
 * profile last chosen on it and its device ID. It lives in `localStorage` and is parsed on read, so a cleared or
 * edited entry falls back to no choice rather than to a malformed id.
 */
import { DeviceId, ProfileId } from "@movies/contracts/ids";
import { Option, Schema } from "effect";

const PROFILE_KEY = "movies.profile";

const DEVICE_KEY = "movies.device";

const decodeProfileId = Schema.decodeUnknownOption(ProfileId);

const decodeDeviceId = Schema.decodeUnknownOption(DeviceId);

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

/**
 * This browser's device ID: one playback session and one room seat per device. Made once and
 * kept; without storage it lasts for this visit.
 */
export const loadDeviceId = (): DeviceId =>
  Option.getOrElse(decodeDeviceId(read(DEVICE_KEY)), () => {
    const created = DeviceId.make(`web-${crypto.randomUUID()}`);

    write(DEVICE_KEY, created);

    return created;
  });

/** Browser names by user-agent pattern, most specific first (Edge and Chrome also say Safari). */
const BROWSERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/Edg\//u, "Edge"],
  [/Firefox\//u, "Firefox"],
  [/Chrome\//u, "Chrome"],
  [/Safari\//u, "Safari"],
];

/** Systems by user-agent pattern; iPhones and iPads also say Mac OS X. */
const SYSTEMS: ReadonlyArray<readonly [RegExp, string]> = [
  [/iPhone|iPad/u, "iOS"],
  [/Mac OS X/u, "macOS"],
  [/Android/u, "Android"],
  [/Windows/u, "Windows"],
];

const firstMatch = (
  agent: string,
  patterns: ReadonlyArray<readonly [RegExp, string]>,
  fallback: string,
): string => patterns.find(([pattern]) => pattern.test(agent))?.[1] ?? fallback;

/** A name for this device in session lists, such as `Chrome on macOS`. */
export const deviceName = (): string => {
  const agent = navigator.userAgent;

  return `${firstMatch(agent, BROWSERS, "Browser")} on ${firstMatch(agent, SYSTEMS, "Linux")}`;
};
