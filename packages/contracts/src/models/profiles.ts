/** Viewing profiles. Each belongs to one account; watch history and my list are per profile. */
import { Schema } from "effect";

import { AgeRating } from "../content-rating";
import { ProfileId } from "../ids";
import { EpochMillis } from "../units";
import { DisplayName } from "./common";

/** An avatar key from the client's avatar set, such as `red` or `fox`. */
export const AvatarKey = Schema.Trimmed.check(Schema.isMinLength(1), Schema.isMaxLength(40));

/** A profile PIN: 4 to 8 digits. */
export const Pin = Schema.String.check(Schema.isPattern(/^\d{4,8}$/u));

/** A viewing profile. */
export const Profile = Schema.Struct({
  id: ProfileId,
  name: Schema.String,
  avatar: Schema.String,
  kids: Schema.Boolean,
  /** The highest age rating this profile sees; null means unrestricted. */
  maxAgeRating: Schema.NullOr(AgeRating),
  hasPin: Schema.Boolean,
  /** The profile has a PIN that this session has not unlocked yet. */
  locked: Schema.Boolean,
  createdAt: EpochMillis,
});

/** A viewing profile. */
export interface Profile extends Schema.Schema.Type<typeof Profile> {}

/** Arguments to create a profile. Kids profiles default to `KIDS_DEFAULT_MAX_AGE`. */
export const CreateProfileArgs = Schema.Struct({
  name: DisplayName,
  avatar: AvatarKey,
  kids: Schema.Boolean,
  maxAgeRating: Schema.optionalKey(Schema.NullOr(AgeRating)),
});

/** Outcome of entering a PIN. Wrong PINs are counted; five in a row lock the profile for five minutes. */
export const UnlockResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal("unlocked") }),
  Schema.Struct({
    status: Schema.Literal("wrong_pin"),
    attemptsLeft: Schema.Int,
  }),
  Schema.Struct({
    status: Schema.Literal("locked_out"),
    retryAt: EpochMillis,
  }),
]);

/** Outcome of entering a PIN. */
export type UnlockResult = typeof UnlockResult.Type;
