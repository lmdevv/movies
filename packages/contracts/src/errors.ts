/**
 * Expected failures of every command. Convex throws `ConvexError({ code, message })`; the media
 * service answers with the same body. Clients decode it with `CommandFailure` and turn it into one
 * tagged error per code with `commandError`.
 */
import { Match, Schema } from "effect";

/** Stable failure codes. Clients branch on these, never on message text. */
export const ErrorCode = Schema.Literals([
  "unauthenticated",
  "forbidden",
  "not_found",
  "invalid_args",
  "conflict",
  "expired",
  "stale_revision",
  "rate_limited",
  "internal",
]);

/** A stable failure code. */
export type ErrorCode = typeof ErrorCode.Type;

/** The wire form of an expected failure: `ConvexError` data and media service error bodies. */
export const CommandFailure = Schema.Struct({
  code: ErrorCode,
  message: Schema.String,
});

/** The wire form of an expected failure. */
export interface CommandFailure extends Schema.Schema.Type<typeof CommandFailure> {}

/** No session, or the session ended (sign-out, key revoked, account disabled). Sign in again. */
export class Unauthenticated extends Schema.TaggedError<Unauthenticated>()("Unauthenticated", {
  message: Schema.String,
}) {}

/** The session lacks the scope, role, ownership, PIN unlock, or host role the command needs. */
export class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", {
  message: Schema.String,
}) {}

/** The record does not exist or the viewer may not see it. Hidden titles report this too. */
export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {
  message: Schema.String,
}) {}

/** The arguments were well-formed but not acceptable, such as an unknown scope or a bad PIN format. */
export class InvalidArgs extends Schema.TaggedError<InvalidArgs>()("InvalidArgs", {
  message: Schema.String,
}) {}

/** The record is not in a state that allows this, such as a used invite or a lost job lease. */
export class Conflict extends Schema.TaggedError<Conflict>()("Conflict", {
  message: Schema.String,
}) {}

/** A code, invite, key, or token has expired. */
export class Expired extends Schema.TaggedError<Expired>()("Expired", {
  message: Schema.String,
}) {}

/** A room command carried an older revision than the room's. Read the committed clock and retry. */
export class StaleRevision extends Schema.TaggedError<StaleRevision>()("StaleRevision", {
  message: Schema.String,
}) {}

/** Too many attempts. Wait and retry, after `retryAfterSeconds` when it is known. */
export class RateLimited extends Schema.TaggedError<RateLimited>()("RateLimited", {
  message: Schema.String,
  retryAfterSeconds: Schema.optional(Schema.Int),
}) {}

/** The server failed in a way the caller cannot fix, such as a missing deployment secret. */
export class Internal extends Schema.TaggedError<Internal>()("Internal", {
  message: Schema.String,
}) {}

/** Any expected command failure. */
export type CommandError =
  | Unauthenticated
  | Forbidden
  | NotFound
  | InvalidArgs
  | Conflict
  | Expired
  | StaleRevision
  | RateLimited
  | Internal;

/** Turns a decoded wire failure into its tagged error. */
export const commandError = (failure: CommandFailure): CommandError => {
  const { message } = failure;

  return Match.value(failure.code).pipe(
    Match.when("unauthenticated", () => new Unauthenticated({ message })),
    Match.when("forbidden", () => new Forbidden({ message })),
    Match.when("not_found", () => new NotFound({ message })),
    Match.when("invalid_args", () => new InvalidArgs({ message })),
    Match.when("conflict", () => new Conflict({ message })),
    Match.when("expired", () => new Expired({ message })),
    Match.when("stale_revision", () => new StaleRevision({ message })),
    Match.when("rate_limited", () => new RateLimited({ message })),
    Match.when("internal", () => new Internal({ message })),
    Match.exhaustive,
  );
};
