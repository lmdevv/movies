/**
 * Bounds the contract schemas put on arguments, enforced again here because Convex validators only
 * check shapes and any client can call a public function directly. `test/registry.test.ts` checks
 * each limit against the contract schema it mirrors.
 */
import type { Infer } from "convex/values";

import { fail } from "./errors";
import type { metadataOverrides } from "./validators";

/** Longest display name (profiles, libraries, API keys, device clients); `DisplayName`. */
export const DISPLAY_NAME_MAX = 80;

/** Shortest password a sign-up or a password change accepts; `NewPassword`. */
export const PASSWORD_MIN = 8;

/** Longest avatar key; `AvatarKey`. */
export const AVATAR_KEY_MAX = 40;

/** Longest client device ID; `DeviceId`. */
export const DEVICE_ID_MAX = 128;

/** Longest library folder path; `LibraryRoot`. */
export const LIBRARY_ROOT_MAX = 1024;

/** Most folders one library has; `roots` in the library commands. */
export const LIBRARY_ROOTS_MAX = 20;

/** The age a kids profile allows unless the account picks another; `KIDS_DEFAULT_MAX_AGE`. */
export const KIDS_DEFAULT_MAX_AGE = 7;

/** Most items one scan or import write may carry; `SCAN_BATCH_LIMIT`. */
export const BATCH_LIMIT = 100;

/** Most archives one backup sync may carry; `BACKUP_SYNC_LIMIT`. */
export const BACKUP_SYNC_LIMIT = 1000;

/**
 * Most collections, and members in all, one `importCollections` call may carry, so its deletes
 * and inserts stay inside one mutation's limits; `COLLECTION_BATCH_LIMIT` and
 * `COLLECTION_MEMBER_BATCH_LIMIT`.
 */
export const COLLECTION_BATCH_LIMIT = 10;

/** Most members, across all collections, one `importCollections` call may carry. */
export const COLLECTION_MEMBER_BATCH_LIMIT = 2000;

/** Highest age rating; `AgeRating` runs from 0 to 21. */
const AGE_RATING_MAX = 21;

/** Trims `value` and requires 1 to `max` characters; `what` names the field in plural. */
const checkText = (value: string, what: string, max: number): string => {
  const trimmed = value.trim();

  if (trimmed.length === 0 || trimmed.length > max) {
    return fail("invalid_args", `${what} have 1 to ${max} characters`);
  }

  return trimmed;
};

/** A trimmed display name of 1 to 80 characters; `what` names the field, such as "Profile names". */
export const checkDisplayName = (value: string, what: string): string =>
  checkText(value, what, DISPLAY_NAME_MAX);

/** A trimmed avatar key of 1 to 40 characters. */
export const checkAvatar = (value: string): string =>
  checkText(value, "Avatar keys", AVATAR_KEY_MAX);

/** A device ID of 1 to 128 characters, kept as sent. */
export const checkDeviceId = (deviceId: string): string =>
  deviceId.length === 0 || deviceId.length > DEVICE_ID_MAX
    ? fail("invalid_args", `Device IDs have 1 to ${DEVICE_ID_MAX} characters`)
    : deviceId;

/** A finite, non-negative duration or position; `what` names it in plural. */
export const checkMilliseconds = (value: number, what: string): number =>
  Number.isFinite(value) && value >= 0
    ? value
    : fail("invalid_args", `${what} are zero or more milliseconds`);

/** An age rating, a whole number of years from 0 to 21, or null for none; `AgeRating`. */
export const checkAgeRating = (age: number | null): number | null =>
  age !== null && (!Number.isInteger(age) || age < 0 || age > AGE_RATING_MAX)
    ? fail("invalid_args", `Age ratings run from 0 to ${AGE_RATING_MAX}`)
    : age;

type MetadataOverrides = Infer<typeof metadataOverrides>;

/** Why each override field would break its contract bound, checked in field order. */
const OVERRIDE_BOUNDS: ReadonlyArray<{
  readonly field: keyof MetadataOverrides;
  readonly broken: (overrides: MetadataOverrides) => boolean;
  readonly message: string;
}> = [
  {
    field: "name",
    broken: ({ name }) => name !== undefined && name.trim() === "",
    message: "Names are not blank",
  },
  {
    field: "sortName",
    broken: ({ sortName }) => sortName !== undefined && sortName.trim() === "",
    message: "Sort names are not blank",
  },
  {
    field: "year",
    broken: ({ year }) => year !== undefined && !Number.isInteger(year),
    message: "Years are whole numbers",
  },
  {
    field: "ageRating",
    broken: ({ ageRating }) =>
      ageRating !== undefined &&
      (!Number.isInteger(ageRating) || ageRating < 0 || ageRating > AGE_RATING_MAX),
    message: `Age ratings run from 0 to ${AGE_RATING_MAX}`,
  },
];

/**
 * Overrides an admin sets: no blank name or sort name, a whole-number year, and an age rating in
 * range. Anything else fails with `invalid_args`.
 */
export const checkOverrides = (overrides: MetadataOverrides): MetadataOverrides => {
  const broken = OVERRIDE_BOUNDS.find((bound) => bound.broken(overrides));

  return broken === undefined ? overrides : fail("invalid_args", broken.message);
};

/**
 * Overrides a migration imports, without the fields that break a bound, so one source title's bad
 * value drops that value instead of failing the whole batch.
 */
export const withoutBrokenOverrides = (overrides: MetadataOverrides): MetadataOverrides => {
  const kept = { ...overrides };

  for (const bound of OVERRIDE_BOUNDS) if (bound.broken(overrides)) delete kept[bound.field];

  return kept;
};

/** At most `BATCH_LIMIT` items, as one scan or import write may carry. */
export const checkBatch = <Item>(items: ReadonlyArray<Item>): ReadonlyArray<Item> =>
  items.length > BATCH_LIMIT
    ? fail("invalid_args", `Send at most ${BATCH_LIMIT} items per call`)
    : items;

/**
 * How many results to return: `fallback` unless asked (or asked for NaN, which no count is), then
 * a whole number from 1 to `max`.
 */
export const resultLimit = (limit: number | undefined, fallback: number, max: number): number =>
  Math.min(
    Math.max(1, Math.floor(limit === undefined || Number.isNaN(limit) ? fallback : limit)),
    max,
  );
