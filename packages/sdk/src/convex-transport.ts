/**
 * The connection to Convex. Every Convex client the SDK runs on (the WebSocket `ConvexClient`, the
 * fetch-based `ConvexHttpClient`, and React's `ConvexReactClient`) is adapted to one small
 * Promise-based `ClientAdapter`; this module turns that into Effect calls and translates Convex's
 * thrown errors into the contracts' tagged errors. Clients call functions by path through
 * `makeFunctionReference`, so they never compile Convex server code.
 */
import type { FunctionPath } from "@movies/contracts/command";
import {
  CommandFailure,
  commandError,
  Internal,
  NotFound,
  Unauthenticated,
} from "@movies/contracts/errors";
import { ConvexClient, ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { makeFunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import {
  Cause,
  Context,
  Duration,
  Effect,
  Layer,
  Option,
  Queue,
  Result,
  Schema,
  Stream,
} from "effect";

import type { CallError } from "./sdk-errors";
import { ProtocolError, TransportError } from "./sdk-errors";

/** How a Convex function runs. */
export type FunctionKind = "query" | "mutation" | "action";

/** Encoded arguments: every command takes one JSON object. */
export type WireArgs = Schema.JsonObject;

/**
 * Supplies the session's Convex auth token, or null when signed out. `forceRefresh` asks for a
 * fresh token because the server rejected the last one.
 */
export type AuthTokenSource = (forceRefresh: boolean) => Promise<string | null>;

/** Stops a subscription. */
export type Unsubscribe = () => void;

/**
 * The calls one Convex client offers, as plain Promises and callbacks. Adapters reject with
 * whatever the client threw; `ConvexTransport` translates it.
 */
export interface ClientAdapter {
  readonly call: (kind: FunctionKind, path: FunctionPath, args: WireArgs) => Promise<Schema.Json>;
  readonly subscribe: (
    path: FunctionPath,
    args: WireArgs,
    onValue: (value: Schema.Json) => void,
    onError: (error: Error) => void,
  ) => Unsubscribe;
  readonly setAuth: (source: AuthTokenSource | null) => void;
  readonly close: () => Promise<void>;
}

/** Calls Convex functions by path with typed failures. */
export interface Interface {
  /** Runs a query, mutation, or action once. */
  readonly call: (
    kind: FunctionKind,
    path: FunctionPath,
    args: WireArgs,
  ) => Effect.Effect<Schema.Json, CallError>;
  /** Every result of a query as it changes. The stream ends only by failing or being interrupted. */
  readonly subscribe: (path: FunctionPath, args: WireArgs) => Stream.Stream<Schema.Json, CallError>;
  /** Uses `source` for the auth token of every later call; null signs the connection out. */
  readonly setAuth: (source: AuthTokenSource | null) => Effect.Effect<void>;
}

/** The connection to the [movies] Convex deployment. */
export class ConvexTransport extends Context.Service<ConvexTransport, Interface>()(
  "@movies/sdk/ConvexTransport",
) {}

/** The body Convex answers HTTP-level failures with, such as a rejected auth token. */
const HttpFailure = Schema.Struct({ code: Schema.String, message: Schema.String });

const decodeHttpFailure = Schema.decodeUnknownOption(Schema.fromJsonString(HttpFailure));

const decodeCommandFailure = Schema.decodeUnknownResult(CommandFailure);

/** HTTP failure codes Convex uses when it cannot verify the auth token. */
const AUTH_FAILURE = /auth|token|jwt|identity/iu;

/** Whether `error` is Convex rejecting the auth token itself, before any function ran. */
const isTokenRejection = (error: Error): boolean => {
  const http = decodeHttpFailure(error.message);

  return Option.isSome(http) && AUTH_FAILURE.test(http.value.code);
};

/**
 * Convex rejecting an argument against a `v.id(table)` validator before the function runs, in the
 * self-hosted backend's two wordings: a string that is no ID at all, such as a mistyped or
 * truncated link, and an ID from another table.
 */
const ID_VALIDATION_FAILURES = [
  /ArgumentValidationError[\s\S]*^Validator: v\.id\("[^"]+"\)$/mu,
  /ArgumentValidationError: Found ID "[^"]*" from table `[^`]*`, which does not match the table name in validator `v\.id\("[^"]+"\)`/u,
] as const;

/** Whether Convex rejected one of the call's ID arguments. */
const isRejectedId = (message: string): boolean =>
  ID_VALIDATION_FAILURES.some((pattern) => pattern.test(message));

/**
 * Translates what a Convex client threw. `ConvexError` data carries a command failure; a token
 * Convex could not verify means the session is gone; an argument that is not an ID of its table
 * names no record, so the call is not found, whichever of its ID arguments it was (screens
 * that pass several IDs check the others first, as `RequireProfile` does for the profile); any
 * other "Server Error" is a function that crashed; anything else is the network.
 */
export const translateFailure = (operation: string, cause: unknown): CallError => {
  if (cause instanceof ConvexError) {
    const failure = decodeCommandFailure(cause.data);

    return Result.isSuccess(failure)
      ? commandError(failure.success)
      : new ProtocolError({
          operation,
          message: `Protocol error in ${operation}: the server's failure carries no known code`,
          cause,
        });
  }

  if (!(cause instanceof Error)) {
    return new TransportError({
      operation,
      message: `Transport failed during ${operation}`,
      cause,
    });
  }

  if (isTokenRejection(cause)) {
    return new Unauthenticated({ message: "The server rejected the session; sign in again" });
  }

  if (isRejectedId(cause.message)) {
    return new NotFound({ message: "No such item: nothing has that ID" });
  }

  if (cause.message.includes("Server Error")) {
    return new Internal({ message: `The server failed while running ${operation}` });
  }

  return new TransportError({
    operation,
    message: `Transport failed during ${operation}: ${cause.message}`,
    cause,
  });
};

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error("Convex client failure", { cause });

/** Builds the transport over one client adapter. The adapter closes when the scope does. */
export const make = (adapter: ClientAdapter): Effect.Effect<Interface> =>
  Effect.succeed(
    ConvexTransport.of({
      call: Effect.fn("ConvexTransport.call")(function* (kind, path, args) {
        return yield* Effect.tryPromise({
          try: () => adapter.call(kind, path, args),
          catch: (cause) => translateFailure(path, cause),
        });
      }),
      subscribe: (path, args) =>
        Stream.callback<Schema.Json, CallError>((queue) =>
          Effect.acquireRelease(
            Effect.sync(() =>
              adapter.subscribe(
                path,
                args,
                (value) => {
                  Queue.offerUnsafe(queue, value);
                },
                (error) => {
                  Queue.failCauseUnsafe(queue, Cause.fail(translateFailure(path, error)));
                },
              ),
            ),
            (unsubscribe) => Effect.sync(unsubscribe),
          ),
        ),
      setAuth: (source) =>
        Effect.sync(() => {
          adapter.setAuth(source);
        }),
    }),
  );

const reference = <Kind extends FunctionKind>(
  kind: Kind,
  path: FunctionPath,
): FunctionReference<Kind, "public", WireArgs, Schema.Json> =>
  makeFunctionReference<Kind, WireArgs, Schema.Json>(path);

/** Adapts the WebSocket client: subscriptions are pushed, and auth refreshes through `source`. */
export const webSocketAdapter = (client: ConvexClient): ClientAdapter => ({
  call: (kind, path, args) => {
    if (kind === "query") return client.query(reference("query", path), args);

    if (kind === "mutation") return client.mutation(reference("mutation", path), args);

    return client.action(reference("action", path), args);
  },
  subscribe: (path, args, onValue, onError) =>
    client.onUpdate(reference("query", path), args, onValue, (error) => {
      onError(toError(error));
    }),
  setAuth: (source) => {
    client.setAuth(async ({ forceRefreshToken }) =>
      source === null ? null : source(forceRefreshToken),
    );
  },
  close: () => client.close(),
});

/** Options for the fetch-based transport. */
export interface HttpOptions {
  /** How often a subscription reads its query again. */
  readonly pollInterval: Duration.Duration;
}

const valueKey = (value: Schema.Json): string => JSON.stringify(value);

/**
 * Adapts the fetch-based client. It has no subscriptions, so `subscribe` polls and reports
 * changed results; it has no refresh hook, so each call reads the token first and retries once
 * with a fresh token when Convex rejects it.
 */
export const httpAdapter = (client: ConvexHttpClient, options: HttpOptions): ClientAdapter => {
  let source: AuthTokenSource | null = null;

  const authorize = async (forceRefresh: boolean): Promise<void> => {
    const token = source === null ? null : await source(forceRefresh);

    if (token === null) client.clearAuth();
    else client.setAuth(token);
  };

  const once = (kind: FunctionKind, path: FunctionPath, args: WireArgs): Promise<Schema.Json> => {
    if (kind === "query") return client.query(reference("query", path), args);

    if (kind === "mutation") return client.mutation(reference("mutation", path), args);

    return client.action(reference("action", path), args);
  };

  const call = async (
    kind: FunctionKind,
    path: FunctionPath,
    args: WireArgs,
  ): Promise<Schema.Json> => {
    await authorize(false);

    try {
      return await once(kind, path, args);
    } catch (cause) {
      if (source === null || !(cause instanceof Error) || !isTokenRejection(cause)) throw cause;
      await authorize(true);

      return once(kind, path, args);
    }
  };

  const subscribe = (
    path: FunctionPath,
    args: WireArgs,
    onValue: (value: Schema.Json) => void,
    onError: (error: Error) => void,
  ): Unsubscribe => {
    let stopped = false;
    let last: string | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async (): Promise<void> => {
      try {
        const value = await call("query", path, args);

        if (stopped) return;
        const key = valueKey(value);

        if (key !== last) {
          last = key;
          onValue(value);
        }

        timer = setTimeout(() => void poll(), Duration.toMillis(options.pollInterval));
      } catch (cause) {
        if (!stopped) onError(toError(cause));
      }
    };

    void poll();

    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  };

  return {
    call,
    subscribe,
    setAuth: (next) => {
      source = next;
    },
    close: () => Promise.resolve(),
  };
};

/** Opens `adapter` for the layer's lifetime and closes it on release. */
const layerFromAdapter = (
  acquire: () => ClientAdapter,
): Layer.Layer<ConvexTransport, TransportError> =>
  Layer.effect(
    ConvexTransport,
    Effect.acquireRelease(
      Effect.try({
        try: acquire,
        catch: (cause) =>
          new TransportError({
            operation: "ConvexTransport.open",
            message: "Transport failed to open: the Convex URL is not valid",
            cause,
          }),
      }),
      (adapter) => Effect.promise(() => adapter.close()),
    ).pipe(Effect.flatMap(make)),
  );

/** A WebSocket connection to `url`: pushed subscriptions and automatic token refresh. */
export const layerWebSocket = (url: string): Layer.Layer<ConvexTransport, TransportError> =>
  layerFromAdapter(() =>
    webSocketAdapter(new ConvexClient(url, { logger: false, unsavedChangesWarning: false })),
  );

/** One-shot HTTP calls to `url`; subscriptions poll. Suits short-lived processes such as the CLI. */
export const layerHttp = (
  url: string,
  options: HttpOptions = { pollInterval: Duration.seconds(1) },
): Layer.Layer<ConvexTransport, TransportError> =>
  layerFromAdapter(() => httpAdapter(new ConvexHttpClient(url, { logger: false }), options));
