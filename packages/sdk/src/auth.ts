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

/** Signs in and out and supplies the session's current token. */
export interface Interface {
  /** The current status, then every change. */
  readonly status: Stream.Stream<AuthStatus>;
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
export const tokenExpiry = (token: string): Option.Option<number> => {
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
  const refreshing = yield* Semaphore.make(1);

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

  const tokenSource: ConvexTransport.AuthTokenSource = (forceRefresh) =>
    Effect.runPromiseWith(context)(
      accessToken(forceRefresh).pipe(
        Effect.map(Option.match({ onNone: () => null, onSome: Redacted.value })),
        Effect.orElseSucceed(() => null),
      ),
    );

  const adopt = Effect.fn("Auth.adopt")(function* (next: Option.Option<StoredSession>) {
    yield* Ref.set(session, next);
    yield* SubscriptionRef.set(status, Option.isSome(next) ? "signedIn" : "signedOut");
    yield* transport.setAuth(Option.isSome(next) ? tokenSource : null);
  });

  const forget = Effect.fn("Auth.forget")(function* () {
    yield* storage.clear;
    yield* adopt(Option.none());
  });

  const signedOut = () => forget().pipe(Effect.as(Option.none<Redacted.Redacted>()));

  const refresh = Effect.fn("Auth.refresh")(function* (seen: Option.Option<StoredSession>) {
    const current = yield* Ref.get(session);

    // Another caller refreshed while this one waited for the permit.
    if (Option.isNone(current) || current !== seen) return Option.map(current, (s) => s.token);

    const renewed = yield* requestTokens({
      refreshToken: Redacted.value(current.value.refreshToken),
    }).pipe(
      Effect.asSome,
      Effect.catchTag("TransportError", () => Effect.succeedNone),
    );

    // Unreachable: keep the current token; the server rejects it if it really expired.
    if (Option.isNone(renewed)) return Option.some(current.value.token);

    if (Option.isNone(renewed.value)) {
      yield* forget();

      return Option.none();
    }

    yield* storage.save(renewed.value.value);
    yield* Ref.set(session, renewed.value);

    return Option.some(renewed.value.value.token);
  });

  function accessToken(
    forceRefresh: boolean,
  ): Effect.Effect<Option.Option<Redacted.Redacted>, TokenStorage.TokenStorageError> {
    return Effect.gen(function* () {
      const current = yield* Ref.get(session);

      if (Option.isNone(current)) return Option.none();
      const now = yield* Clock.currentTimeMillis;

      const keep = Effect.succeedSome(current.value.token);

      if (!forceRefresh && !isExpiring(Redacted.value(current.value.token), now))
        return yield* keep;

      return yield* refreshing.withPermits(1)(
        refresh(current).pipe(
          Effect.catchTags({
            // The refresh token was refused: the session is over.
            Unauthenticated: signedOut,
            Forbidden: signedOut,
            Expired: signedOut,
            // Any other failure keeps the token; the server rejects it if it really expired.
            NotFound: () => keep,
            InvalidArgs: () => keep,
            Conflict: () => keep,
            StaleRevision: () => keep,
            RateLimited: () => keep,
            Internal: () => keep,
            ProtocolError: () => keep,
          }),
        ),
      );
    });
  }

  const signIn = Effect.fn("Auth.signIn")(function* (credentials: Credentials) {
    const opened = yield* requestTokens(providerParams(credentials));

    if (Option.isNone(opened)) {
      return yield* new Unauthenticated({
        message: "Sign-in refused: the server did not accept these credentials",
      });
    }

    yield* storage.save(opened.value);

    return yield* adopt(opened);
  });

  const signOut = Effect.fn("Auth.signOut")(function* () {
    const current = yield* Ref.get(session);

    if (Option.isSome(current)) {
      yield* callGateway(SIGN_OUT, {}, Option.some(current.value.token)).pipe(Effect.ignore);
    }

    yield* forget();
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
