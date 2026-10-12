/**
 * Content ratings. Titles store the certification as published (`PG-13`, `TV-MA`, `15`) and a
 * minimum viewer age derived from it. A profile with a maximum age sees only titles whose age is
 * known and at most that maximum; unrated titles stay hidden from it.
 */
import { Schema } from "effect";

/** The minimum viewer age a certification implies, from 0 (all ages) to 21. */
export const AgeRating = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 21 })).pipe(
  Schema.brand("AgeRating"),
);

/** A minimum viewer age. */
export type AgeRating = typeof AgeRating.Type;

const makeAgeRating = Schema.decodeSync(AgeRating);

/** The age a new kids profile allows unless the account chooses another. */
export const KIDS_DEFAULT_MAX_AGE: AgeRating = makeAgeRating(7);

const CERTIFICATION_AGES: ReadonlyMap<string, number> = new Map([
  // United States: MPA film ratings.
  ["G", 0],
  ["PG", 7],
  ["PG-13", 13],
  ["R", 17],
  ["NC-17", 18],
  // United States: TV parental guidelines.
  ["TV-Y", 0],
  ["TV-Y7", 7],
  ["TV-Y7-FV", 7],
  ["TV-G", 0],
  ["TV-PG", 10],
  ["TV-14", 14],
  ["TV-MA", 17],
  // United Kingdom: BBFC.
  ["U", 0],
  ["12A", 12],
  ["R18", 18],
]);

const LEADING_AGE = /^(?:FSK|PEGI|TV|BBFC|IMDA|MA|M)?[\s-]*(\d{1,2})\+?$/u;

/**
 * The minimum age for a certification string, or `undefined` when it is unrated or unknown.
 * Recognizes US film and TV ratings, BBFC ratings, and plain ages such as `12`, `16+`, or `FSK 16`.
 */
export const ageRatingFromCertification = (certification: string): AgeRating | undefined => {
  const normalized = certification.trim().toUpperCase();
  const known = CERTIFICATION_AGES.get(normalized);

  if (known !== undefined) return makeAgeRating(known);

  const match = LEADING_AGE.exec(normalized);
  const digits = match?.[1];

  if (digits === undefined) return undefined;
  const age = Number.parseInt(digits, 10);

  return age <= 21 ? makeAgeRating(age) : undefined;
};

/** Whether a profile with `maxAge` (none means unrestricted) may see a title rated `age`. */
export const isAllowedForAge = (
  age: AgeRating | undefined,
  maxAge: AgeRating | undefined,
): boolean => maxAge === undefined || (age !== undefined && age <= maxAge);
