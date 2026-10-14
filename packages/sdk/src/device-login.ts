/**
 * Device sign-in for the CLI and TVs: request a code, show the short user code and a QR code of
 * the approval URL, watch `deviceAuth.status` until someone approves it from a signed-in session,
 * then sign in with the secret device code. The QR code holds the approval URL, never a credential.
 */
import type { DeviceCodeState } from "@movies/contracts/models/account";
import type { EpochMillis } from "@movies/contracts/units";
import { Clock, Duration, Effect, Option, Redacted, Schedule, Schema, Stream } from "effect";

import * as Auth from "./auth";
import { MoviesClient } from "./movies-client";
import type { CallError } from "./sdk-errors";
import { isTransient } from "./sdk-errors";
import type { TokenStorageError } from "./token-storage";

/** The device sign-in was denied, expired, or already used. Start a new one. */
export class DeviceLoginRefused extends Schema.TaggedError<DeviceLoginRefused>()(
  "DeviceLoginRefused",
  {
    state: Schema.Literals(["denied", "expired", "consumed"]),
    message: Schema.String,
  },
) {}

/** A pending device sign-in. */
export interface DeviceLogin {
  /** The short code the person types or confirms on the approval page. */
  readonly userCode: string;
  /** The approval page; render it as a QR code too. */
  readonly verificationUrl: string;
  /** When the server stops accepting approval; `complete` gives up shortly after. */
  readonly expiresAt: EpochMillis;
  /** Waits for approval, then signs this client in. */
  readonly complete: Effect.Effect<void, DeviceLoginRefused | CallError | TokenStorageError>;
}

/** Time allowed past the server's expiry for clock differences before giving up locally. */
const EXPIRY_GRACE_MS = 5_000;

/**
 * The wait before watching the status again after a poll failed in transit or was rate limited.
 * Retries stop when the sign-in expires.
 */
const STATUS_RETRY_SPACING = Duration.seconds(2);

/** A status someone decided: anything but `pending`. */
interface DecidedStatus {
  readonly state: Exclude<DeviceCodeState, "pending">;
}

const isDecided = (status: { readonly state: DeviceCodeState }): status is DecidedStatus =>
  status.state !== "pending";

/** Starts a device sign-in named `clientName`, as the approving person will see it. */
export const start: (
  clientName: string,
) => Effect.Effect<DeviceLogin, CallError, MoviesClient | Auth.Auth> = Effect.fn(
  "DeviceLogin.start",
)(function* (clientName: string) {
  const client = yield* MoviesClient;
  const auth = yield* Auth.Auth;
  const request = yield* client.action("deviceAuth.request", { clientName });
  const deviceCode = Redacted.make(request.deviceCode);

  const complete = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const waitMs = Math.max(0, request.expiresAt - now) + EXPIRY_GRACE_MS;

    const decided = yield* client
      .subscribe("deviceAuth.status", { deviceCode: Redacted.value(deviceCode) })
      .pipe(
        Stream.filter(isDecided),
        Stream.runHead,
        Effect.retry({ while: isTransient, schedule: Schedule.spaced(STATUS_RETRY_SPACING) }),
        Effect.timeoutOption(Duration.millis(waitMs)),
        Effect.map(Option.flatten),
      );

    const state = Option.match(decided, {
      onNone: () => "expired" as const,
      onSome: (status) => status.state,
    });

    if (state === "approved") {
      return yield* auth.signIn(Auth.Credentials.DeviceCode({ deviceCode }));
    }

    return yield* new DeviceLoginRefused({
      state,
      message: `Device sign-in ${state}: start a new sign-in`,
    });
  }).pipe(Effect.withSpan("DeviceLogin.complete"));

  const login: DeviceLogin = {
    userCode: request.userCode,
    verificationUrl: request.verificationUrl,
    expiresAt: request.expiresAt,
    complete,
  };

  return login;
});
