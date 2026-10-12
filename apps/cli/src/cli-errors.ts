/**
 * Failures the CLI reports, and the stable exit code and `{ code, message }` report of each.
 * Agents branch on exit codes and codes, never on message text.
 */
import type { CommandError } from "@movies/contracts/errors";
import type { CallError } from "@movies/sdk/effect";
import { Match, Schema } from "effect";

/** The command line was wrong: an unknown command, a missing flag, or a value the schema rejects. */
export class UsageError extends Schema.TaggedError<UsageError>()("UsageError", {
  message: Schema.String,
  /** The command whose help explains the fix, such as `rooms pause`. */
  command: Schema.NullOr(Schema.String),
}) {}

/** Reading or writing the config file failed, or it holds something the CLI cannot read. */
export class ConfigFileError extends Schema.TaggedError<ConfigFileError>()("ConfigFileError", {
  path: Schema.String,
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

/** A job followed with `--wait` failed, was cancelled, or outlived `--timeout`. */
export class JobError extends Schema.TaggedError<JobError>()("JobError", {
  code: Schema.Literals(["job_failed", "job_cancelled", "timeout"]),
  jobId: Schema.String,
  message: Schema.String,
}) {}

/** The CLI is not signed in to any server yet. */
export class NotLoggedIn extends Schema.TaggedError<NotLoggedIn>()("NotLoggedIn", {
  message: Schema.String,
}) {}

/** A device sign-in was denied, expired, or already used. */
export class LoginRefused extends Schema.TaggedError<LoginRefused>()("LoginRefused", {
  message: Schema.String,
}) {}

/** An external program such as mpv could not be started. */
export class LaunchError extends Schema.TaggedError<LaunchError>()("LaunchError", {
  program: Schema.String,
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

/** Every expected failure the CLI reports. */
export type CliError =
  | CallError
  | UsageError
  | ConfigFileError
  | JobError
  | NotLoggedIn
  | LoginRefused
  | LaunchError;

/** Process exit codes. Stable: agents branch on them. */
export const ExitCode = {
  ok: 0,
  failed: 1,
  usage: 2,
  unauthenticated: 3,
  forbidden: 4,
  notFound: 5,
  conflict: 6,
  expired: 7,
  rateLimited: 8,
  unavailable: 9,
  job: 10,
} as const;

/** A process exit code. */
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

/** The stable `code` and readable `message` printed for an error. */
export interface ErrorReport {
  readonly code: string;
  readonly message: string;
}

const commandCode: (error: CommandError) => string = Match.type<CommandError>().pipe(
  Match.tagsExhaustive({
    Unauthenticated: () => "unauthenticated",
    Forbidden: () => "forbidden",
    NotFound: () => "not_found",
    InvalidArgs: () => "invalid_args",
    Conflict: () => "conflict",
    Expired: () => "expired",
    StaleRevision: () => "stale_revision",
    RateLimited: () => "rate_limited",
    Internal: () => "internal",
  }),
);

/** Maps an error to its exit code. */
export const exitCodeOf: (error: CliError) => ExitCode = Match.type<CliError>().pipe(
  Match.tagsExhaustive({
    Unauthenticated: () => ExitCode.unauthenticated,
    NotLoggedIn: () => ExitCode.unauthenticated,
    LoginRefused: () => ExitCode.unauthenticated,
    Forbidden: () => ExitCode.forbidden,
    NotFound: () => ExitCode.notFound,
    InvalidArgs: () => ExitCode.usage,
    UsageError: () => ExitCode.usage,
    Conflict: () => ExitCode.conflict,
    StaleRevision: () => ExitCode.conflict,
    Expired: () => ExitCode.expired,
    RateLimited: () => ExitCode.rateLimited,
    TransportError: () => ExitCode.unavailable,
    JobError: () => ExitCode.job,
    Internal: () => ExitCode.failed,
    ProtocolError: () => ExitCode.failed,
    ConfigFileError: () => ExitCode.failed,
    LaunchError: () => ExitCode.failed,
  }),
);

/** Maps an error to the `{ code, message }` pair printed on stderr. */
export const reportOf: (error: CliError) => ErrorReport = Match.type<CliError>().pipe(
  Match.tagsExhaustive({
    Unauthenticated: (error) => ({ code: commandCode(error), message: error.message }),
    Forbidden: (error) => ({ code: commandCode(error), message: error.message }),
    NotFound: (error) => ({ code: commandCode(error), message: error.message }),
    InvalidArgs: (error) => ({ code: commandCode(error), message: error.message }),
    Conflict: (error) => ({ code: commandCode(error), message: error.message }),
    Expired: (error) => ({ code: commandCode(error), message: error.message }),
    StaleRevision: (error) => ({ code: commandCode(error), message: error.message }),
    RateLimited: (error) => ({ code: commandCode(error), message: error.message }),
    Internal: (error) => ({ code: commandCode(error), message: error.message }),
    TransportError: (error) => ({ code: "unavailable", message: error.message }),
    ProtocolError: (error) => ({ code: "protocol_error", message: error.message }),
    UsageError: (error) => ({ code: "usage", message: error.message }),
    ConfigFileError: (error) => ({ code: "config_error", message: error.message }),
    JobError: (error) => ({ code: error.code, message: error.message }),
    NotLoggedIn: (error) => ({ code: "not_logged_in", message: error.message }),
    LoginRefused: (error) => ({ code: "login_refused", message: error.message }),
    LaunchError: (error) => ({ code: "launch_failed", message: error.message }),
  }),
);
