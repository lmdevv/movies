import { Schema } from "effect";

/** A non-negative duration or media position in milliseconds. */
export const Milliseconds = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
  Schema.brand("Milliseconds"),
);

/** A duration or media position in milliseconds. */
export type Milliseconds = typeof Milliseconds.Type;

/** The latest instant a JavaScript `Date` can represent. */
const MAX_DATE_MS = 8_640_000_000_000_000;

/** An instant as whole milliseconds since the Unix epoch, as `Date.now()` returns. */
export const EpochMillis = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: MAX_DATE_MS }),
).pipe(Schema.brand("EpochMillis"));

/** An instant in milliseconds since the Unix epoch. */
export type EpochMillis = typeof EpochMillis.Type;

/** A size in bytes. */
export const Bytes = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(Schema.brand("Bytes"));

/** A size in bytes. */
export type Bytes = typeof Bytes.Type;
