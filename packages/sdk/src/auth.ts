/**
 * Signing in and keeping the session's token fresh. Convex Auth issues a JWT that lasts an hour
 * and a refresh token that renews it. This service signs in with a password, an API key, or an
 * approved device code, stores the tokens through `TokenStorage`, hands the Convex connection a
 * token source that refreshes on demand, and signs out on the server and locally.
 *
 * Sign-in and refresh go through a private fetch-based client rather than the shared connection:
 * the WebSocket client waits for its token before running calls, so refreshing through it would
 * wait on itself.
 */
import type { FunctionPath } from "@movies/contracts/command";
import { Unauthenticated } from "@movies/contracts/errors";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import type { Value } from "convex/values";
import {
  Clock,
  Context,
  Data,
  Duration,
  Effect,
  Layer,
  Option,
  Redacted,
  Ref,
  Result,
  Schema,
  Semaphore,
  SubscriptionRef,
} from "effect";
import type { Stream } from "effect";
import * as Base64Url from "effect/encoding/Base64Url";

import * as ConvexTransport from "./convex-transport";
import type { CallError } from "./sdk-errors";
import { ProtocolError } from "./sdk-errors";
import * as TokenStorage from "./token-storage";
import type { StoredSession } from "./token-storage";

/** Whether the client holds a session. `loading` lasts until stored tokens have been read. */
export type AuthStatus = "loading" | "signedOut" | "signedIn";

/** What to sign in with. Each case is one Convex Auth provider. */
export type Credentials = Data.TaggedEnum<{
  /** Email and password. `signUp` creates the first account (the owner) or redeems an invite. */
  Password: {
    readonly flow: "signIn" | "signUp";
    readonly email: string;
    readonly password: Redacted.Redacted;
    readonly name: Option.Option<string>;
    readonly inviteCode: Option.Option<string>;
  };
  /** A scoped API key, as `movies keys create` or Settings shows it once. */
  ApiKey: { readonly key: Redacted.Redacted };
  /** The secret device code of an approved device sign-in. */
  DeviceCode: { readonly deviceCode: Redacted.Redacted };
}>;

/** Constructors and matchers for `Credentials`. */
export const Credentials = Data.taggedEnum<Credentials>();

/** Email and password sign-in or sign-up as plain values, for the Promise and React entry points. */
export interface PasswordSignIn {
  readonly flow: "signIn" | "signUp";
  readonly email: string;
  readonly password: string;
  /** The new account's display name, for `signUp`. */
  readonly name?: string;
  /** The invite to redeem, for `signUp` after the owner exists. */
  readonly inviteCode?: string;
}

/** The `Password` credentials for `input`, with the password redacted. */
export const passwordCredentials = (input: PasswordSignIn): Credentials =>
  Credentials.Password({
    flow: input.flow,
    email: input.email,
    password: Redacted.make(input.password),
    name: Option.fromNullishOr(input.name),
    inviteCode: Option.fromNullishOr(input.inviteCode),
  });

/** Signs in and out and supplies the session's current token. */
export interface Interface {
  /** The current status, then every change. */
  readonly status: Stream.Stream<AuthStatus>;
  /** The status now, without waiting for a change. */
  readonly currentStatus: Effect.Effect<AuthStatus>;
  /**
   * Signs in and stores the session. Rejected credentials fail with `Unauthenticated`; a sign-up
   * without a valid invite fails with `Forbidden` or `Conflict`.
   */
  readonly signIn: (
    credentials: Credentials,
  ) => Effect.Effect<void, CallError | TokenStorage.TokenStorageError>;
  /** Ends the session on the server when reachable, then forgets it locally. */
  readonly signOut: Effect.Effect<void, TokenStorage.TokenStorageError>;
  /**
   * The token for the next request, refreshed when it is about to expire or when `forceRefresh`
   * says the server rejected it. None when signed out or when the refresh token was refused.
   */
  readonly accessToken: (
    forceRefresh: boolean,
  ) => Effect.Effect<Option.Option<Redacted.Redacted>, TokenStorage.TokenStorageError>;
}

/** The SDK's sign-in state. */
export class Auth extends Context.Service<Auth, Interface>()("@movies/sdk/Auth") {}

const Tokens = Schema.Struct({ token: Schema.String, refreshToken: Schema.String });

/** `auth:signIn` answers with tokens, null tokens when it signed nobody in, or a redirect. */
const SignInResult = Schema.Struct({ tokens: Schema.optionalKey(Schema.NullOr(Tokens)) });

const decodeSignInResult = Schema.decodeUnknownEffect(SignInResult);

const JwtClaims = Schema.Struct({ exp: Schema.Finite });

const decodeClaims = Schema.decodeUnknownOption(Schema.fromJsonString(JwtClaims));

/** Tokens are renewed this long before they expire, so no request races the expiry. */
const EXPIRY_MARGIN_MS = 60_000;

/** When `token` expires in epoch milliseconds, or none when it carries no readable `exp`. */
const tokenExpiry = (token: string): Option.Option<number> => {
  const [, payload] = token.split(".");

  if (payload === undefined) return Option.none();
  const text = Base64Url.decodeString(payload);

  return Result.isSuccess(text)
    ? Option.map(decodeClaims(text.success), (claims) => claims.exp * 1000)
    : Option.none();
};

/** Whether `token` should be renewed at `now`. Tokens without an expiry are used until rejected. */
const isExpiring = (token: string, now: number): boolean =>
  Option.match(tokenExpiry(token), {
    onNone: () => false,
    onSome: (expiresAt) => expiresAt - EXPIRY_MARGIN_MS <= now,
  });

const toSession = (tokens: typeof Tokens.Type): StoredSession => ({
  token: Redacted.make(tokens.token),
  refreshToken: Redacted.make(tokens.refreshToken),
});

const providerParams = (credentials: Credentials): Readonly<Record<string, Value>> =>
  Credentials.$match(credentials, {
    Password: ({ flow, email, password, name, inviteCode }) => ({
      provider: "password",
      params: {
        flow,
        email,
        password: Redacted.value(password),
        ...Option.match(name, { onNone: () => ({}), onSome: (value) => ({ name: value }) }),
        ...Option.match(inviteCode, {
          onNone: () => ({}),
          onSome: (value) => ({ inviteCode: value }),
        }),
      },
    }),
    ApiKey: ({ key }) => ({ provider: "apikey", params: { key: Redacted.value(key) } }),
    DeviceCode: ({ deviceCode }) => ({
      provider: "device",
      params: { deviceCode: Redacted.value(deviceCode) },
    }),
  });

const SIGN_IN: FunctionPath = "auth:signIn";

const SIGN_OUT: FunctionPath = "auth:signOut";

/** Options for the auth layer. */
export interface Options {
  /** The Convex deployment URL, the same one the connection uses. */
  readonly convexUrl: string;
}

/** What a refresh request came back with. */
type RefreshOutcome = Data.TaggedEnum<{
  /** The server issued new tokens and spent the old refresh token. */
  Renewed: { readonly session: StoredSession };
  /** The server refused the refresh token: the session is over. */
  Refused: {};
  /** No usable answer, such as an unreachable server: keep the current token. */
  Kept: {};
}>;

const RefreshOutcome = Data.taggedEnum<RefreshOutcome>();

const refused = () => Effect.succeed(RefreshOutcome.Refused());

const kept = () => Effect.succeed(RefreshOutcome.Kept());

/**
 * How long a refresh waits for the server. Every other refresh waits on the one in flight, so a
 * hung request would stall every call. Giving up keeps the current token; if the server did spend
 * the refresh token after all, the next refresh is refused and the client signs out.
 */
const REFRESH_TIMEOUT = Duration.seconds(30);

/**
 * How long sign-out tries to end the session on the server, renewing its token first if needed.
 * The local session is already gone by then, so giving up only leaves the server session to expire.
 */
const SERVER_SIGN_OUT_TIMEOUT = Duration.seconds(10);

/**
 * Builds the auth service: reads the stored session, then gives the Convex connection a token
 * source. Requires the connection and a token store.
 */
export const make = Effect.fn("Auth.make")(function* (options: Options) {
  const transport = yield* ConvexTransport.ConvexTransport;
  const storage = yield* TokenStorage.TokenStorage;
  const context = yield* Effect.context();
  const gateway = new ConvexHttpClient(options.convexUrl, { logger: false });
  const status = yield* SubscriptionRef.make<AuthStatus>("loading");
  const session = yield* Ref.make(Option.none<StoredSession>());
  // One refresh request at a time, so concurrent callers share it.
  const refreshing = yield* Semaphore.make(1);

  // How many refresh requests have finished, and for which session. A caller that sees one finish
  // for its session while it waited for `refreshing` takes that outcome instead of asking again.
  const lastAttempt = yield* Ref.make<{
    readonly finished: number;
    readonly session: Option.Option<StoredSession>;
  }>({ finished: 0, session: Option.none() });

  // Session changes (sign-in, sign-out, a refresh's result) apply one at a time. Holders never wait
  // on the network, so signing out is not held up by a refresh in flight.
  const committing = yield* Semaphore.make(1);

  const callGateway = Effect.fn("Auth.callGateway")(function* (
    path: FunctionPath,
    args: Readonly<Record<string, Value>>,
    token: Option.Option<Redacted.Redacted>,
  ) {
    return yield* Effect.tryPromise({
      try: () => {
        if (Option.isSome(token)) gateway.setAuth(Redacted.value(token.value));
        else gateway.clearAuth();

        return gateway.action(
          makeFunctionReference<"action", typeof args, Schema.Json>(path),
          args,
        );
      },
      catch: (cause) => ConvexTransport.translateFailure(path, cause),
    });
  });

  /** Runs `auth:signIn` and returns the session it opened, if any. */
  const requestTokens = Effect.fn("Auth.requestTokens")(function* (
    args: Readonly<Record<string, Value>>,
  ) {
    const raw = yield* callGateway(SIGN_IN, args, Option.none());

    const result = yield* decodeSignInResult(raw).pipe(
      Effect.mapError(
        (cause) =>
          new ProtocolError({
            operation: SIGN_IN,
            message: "Protocol error in auth:signIn: unexpected sign-in response",
            cause,
          }),
      ),
    );

    return Option.map(Option.fromNullishOr(result.tokens), toSession);
  });

  const currentToken = Effect.map(
    Ref.get(session),
    Option.map((current) => current.token),
  );

  /**
   * Falls back to the token in memory when storing a renewed session failed: the renewed session
   * is held in memory before it is stored, so it stays usable for this process.
   */
  const orTokenInMemory = (
    token: Effect.Effect<Option.Option<Redacted.Redacted>, TokenStorage.TokenStorageError>,
  ): Effect.Effect<Option.Option<Redacted.Redacted>> =>
    token.pipe(
      Effect.catchTag("TokenStorageError", (error) =>
        Effect.logWarning("Auth.tokenStorageFailed", error).pipe(Effect.andThen(currentToken)),
      ),
    );

  const tokenSource: ConvexTransport.AuthTokenSource = (forceRefresh) =>
    Effect.runPromiseWith(context)(
      accessToken(forceRefresh).pipe(
        orTokenInMemory,
        Effect.map(Option.match({ onNone: () => null, onSome: Redacted.value })),
      ),
    );

  /** Holds `next` and points the connection and the status at it. Callers hold `committing`. */
  const adopt = Effect.fn("Auth.adopt")(function* (next: Option.Option<StoredSession>) {
    yield* Ref.set(session, next);
    // The connection has its token source before anyone hears of the change.
    yield* transport.setAuth(Option.isSome(next) ? tokenSource : null);
    yield* SubscriptionRef.set(status, Option.isSome(next) ? "signedIn" : "signedOut");
  });

  /**
   * Forgets the session in memory, then in storage. Memory goes first so a storage failure cannot
   * keep a dead session in use. Callers hold `committing`.
   */
  const forget = Effect.fn("Auth.forget")(function* () {
    yield* adopt(Option.none());
    yield* storage.clear;
  });

  /** Asks the server to renew `seen`. Failures become the outcome they call for. */
  const requestRefresh = (seen: StoredSession): Effect.Effect<RefreshOutcome> =>
    requestTokens({ refreshToken: Redacted.value(seen.refreshToken) }).pipe(
      Effect.map(
        Option.match({
          onNone: () => RefreshOutcome.Refused(),
          onSome: (renewed) => RefreshOutcome.Renewed({ session: renewed }),
        }),
      ),
      Effect.timeoutOption(REFRESH_TIMEOUT),
      Effect.map(Option.getOrElse(() => RefreshOutcome.Kept())),
      Effect.catchTags({
        Unauthenticated: refused,
        Forbidden: refused,
        Expired: refused,
        // Any other failure keeps the token; the server rejects it if it really expired.
        TransportError: kept,
        NotFound: kept,
        InvalidArgs: kept,
        Conflict: kept,
        StaleRevision: kept,
        RateLimited: kept,
        Internal: kept,
        ProtocolError: kept,
      }),
    );

  /**
   * Applies a refresh's outcome to the session it started from. When a sign-in or sign-out
   * replaced that session while the request was in flight, the newer session stands.
   */
  const commitRefresh = Effect.fn("Auth.commitRefresh")(function* (
    seen: StoredSession,
    outcome: RefreshOutcome,
  ) {
    const current = yield* Ref.get(session);

    if (Option.isNone(current) || current.value !== seen) {
      return Option.map(current, (held) => held.token);
    }

    return yield* RefreshOutcome.$match(outcome, {
      Renewed: ({ session: renewed }) =>
        // Memory first: the old refresh token is spent, so a failed save must not leave it held.
        Ref.set(session, Option.some(renewed)).pipe(
          Effect.andThen(storage.save(renewed)),
          Effect.as(Option.some(renewed.token)),
        ),
      Refused: () => forget().pipe(Effect.as(Option.none<Redacted.Redacted>())),
      Kept: () => Effect.succeedSome(seen.token),
    });
  }, committing.withPermits(1));

  /**
   * Renews `seen`, unless another caller replaced it while this one waited for the permit.
   * `generation` is the finished-attempt count the caller saw before waiting. An attempt for `seen`
   * that finished since, with `seen` still standing, kept the token (the server was unreachable or
   * slow); asking again would only wait as long, so this caller keeps the token too.
   */
  const refresh = Effect.fn("Auth.refresh")(function* (seen: StoredSession, generation: number) {
    const current = yield* Ref.get(session);

    if (Option.isNone(current) || current.value !== seen) {
      return Option.map(current, (held) => held.token);
    }

    const last = yield* Ref.get(lastAttempt);

    if (last.finished !== generation && Option.exists(last.session, (tried) => tried === seen)) {
      return Option.some(seen.token);
    }

    const outcome = yield* requestRefresh(seen);

    yield* Ref.update(lastAttempt, (previous) => ({
      finished: previous.finished + 1,
      session: Option.some(seen),
    }));

    return yield* commitRefresh(seen, outcome);
  }, refreshing.withPermits(1));

  function accessToken(
    forceRefresh: boolean,
  ): Effect.Effect<Option.Option<Redacted.Redacted>, TokenStorage.TokenStorageError> {
    return Effect.gen(function* () {
      const current = yield* Ref.get(session);

      if (Option.isNone(current)) return Option.none();
      const { finished: generation } = yield* Ref.get(lastAttempt);
      const now = yield* Clock.currentTimeMillis;

      if (!forceRefresh && !isExpiring(Redacted.value(current.value.token), now)) {
        return Option.some(current.value.token);
      }

      return yield* refresh(current.value, generation);
    });
  }

  const signIn = Effect.fn("Auth.signIn")(function* (credentials: Credentials) {
    const opened = yield* requestTokens(providerParams(credentials));

    if (Option.isNone(opened)) {
      return yield* new Unauthenticated({
        message: "Sign-in refused: the server did not accept these credentials",
      });
    }

    return yield* committing.withPermits(1)(
      storage.save(opened.value).pipe(Effect.andThen(adopt(opened))),
    );
  });

  /**
   * Ends `ended` on the server, best effort. The server ignores an expired token, so one about to
   * expire is renewed first with the session's own refresh token; nothing here touches the local
   * session, which is already gone.
   */
  const endOnServer = (ended: StoredSession): Effect.Effect<void> =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;

      const token = isExpiring(Redacted.value(ended.token), now)
        ? Option.map(
            yield* requestTokens({ refreshToken: Redacted.value(ended.refreshToken) }),
            (renewed) => renewed.token,
          )
        : Option.some(ended.token);

      if (Option.isSome(token)) yield* callGateway(SIGN_OUT, {}, token);
    }).pipe(Effect.timeoutOption(SERVER_SIGN_OUT_TIMEOUT), Effect.ignore);

  const signOut = Effect.fn("Auth.signOut")(function* () {
    // Forget locally first, so signing out never waits on the server.
    const { ended, cleared } = yield* committing.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(session);
        const exit = yield* Effect.exit(forget());

        return { ended: current, cleared: exit };
      }),
    );

    if (Option.isSome(ended)) yield* endOnServer(ended.value);

    return yield* cleared;
  });

  const stored = yield* storage.load;

  yield* adopt(stored);

  return Auth.of({
    status: SubscriptionRef.changes(status),
    currentStatus: SubscriptionRef.get(status),
    signIn,
    signOut: signOut(),
    accessToken,
  });
});

/** The auth service over the given connection and token store. */
export const layer = (
  options: Options,
): Layer.Layer<
  Auth,
  TokenStorage.TokenStorageError,
  ConvexTransport.ConvexTransport | TokenStorage.TokenStorage
> => Layer.effect(Auth, make(options));
