import { mediaServiceFunctions } from "@movies/contracts/media-service";
import type { MediaServiceFunctions } from "@movies/contracts/media-service";
import { InvalidArgs } from "@movies/contracts/errors";
import {
  Auth,
  ConvexTransport,
  ProtocolError,
  TokenStorage,
  TransportError,
} from "@movies/sdk/effect";
import type { CallError } from "@movies/sdk/effect";
import {
  Context,
  Deferred,
  Duration,
  Effect,
  Layer,
  Predicate,
  type Redacted,
  Ref,
  Schedule,
  Schema,
  Semaphore,
  Stream,
} from "effect";

import * as BackendHealth from "../backend-health.ts";

/** A media service function by its registry name, such as `mediaService.claimJob`. */
export type FunctionName = keyof MediaServiceFunctions;

/** Media service functions served by a Convex query; only these can be subscribed to. */
export type QueryName = {
  readonly [Name in FunctionName]: MediaServiceFunctions[Name]["kind"] extends "query"
    ? Name
    : never;
}[FunctionName];

/** Decoded arguments of a media service function. */
export type FunctionArgs<Name extends FunctionName> = MediaServiceFunctions[Name]["args"]["Type"];

/** Decoded result of a media service function. */
export type FunctionResult<Name extends FunctionName> =
  MediaServiceFunctions[Name]["result"]["Type"];

/** Calls the media service functions as the service account. */
export interface Interface {
  /** Runs a function once; waits up to fifteen seconds for the first sign-in. */
  readonly call: <Name extends FunctionName>(
    name: Name,
    args: FunctionArgs<Name>,
  ) => Effect.Effect<FunctionResult<Name>, CallError>;
  /**
   * The query's result now and after every change. A dropped subscription is resumed with
   * backoff, so the stream never ends on its own.
   */
  readonly subscribe: <Name extends QueryName>(
    name: Name,
    args: FunctionArgs<Name>,
  ) => Stream.Stream<FunctionResult<Name>>;
  /** Whether the service account is signed in. */
  readonly status: Effect.Effect<"connected" | "connecting">;
}

/** The Convex connection. */
export class Service extends Context.Service<Service, Interface>()("@movies/media/MediaBackend") {}

/** Where to connect and as whom. */
export interface Options {
  readonly convexUrl: string;
  readonly apiKey: Redacted.Redacted;
  /** Longest one call may wait for its answer; 30 seconds when absent. */
  readonly callTimeout?: Duration.Duration;
}

const READY_WAIT = Duration.seconds(15);

/**
 * Longest one call may wait for its answer. The WebSocket transport queues calls while it
 * reconnects; without a bound, a call made during an outage waits for as long as the outage lasts.
 * A timed-out mutation may still apply later, as any lost answer may, so callers retry only
 * idempotent work.
 */
const DEFAULT_CALL_TIMEOUT = Duration.seconds(30);

const backoff = Schedule.min([
  Schedule.exponential("500 millis"),
  Schedule.spaced("30 seconds"),
]).pipe(Schedule.jittered);

const decodeWireArgs = Schema.decodeUnknownEffect(Schema.JsonObject);

const encodeArgs = <Name extends FunctionName>(name: Name, args: FunctionArgs<Name>) =>
  Schema.encodeUnknownEffect(mediaServiceFunctions[name].args)(args).pipe(
    Effect.flatMap(decodeWireArgs),
    Effect.mapError(
      (error) => new InvalidArgs({ message: `Invalid arguments for ${name}: ${error.message}` }),
    ),
  );

const decodeResult = <Name extends FunctionName>(
  name: Name,
  raw: Schema.Json,
): Effect.Effect<FunctionResult<Name>, ProtocolError> =>
  Schema.decodeUnknownEffect(mediaServiceFunctions[name].result)(raw).pipe(
    Effect.mapError(
      (cause) =>
        new ProtocolError({
          operation: name,
          message: `Protocol error in ${name}: the result does not match the contract`,
          cause,
        }),
    ),
  );

const make = Effect.fn("MediaBackend.make")(function* (options: Options) {
  const sdk = yield* Layer.build(
    Auth.layer({ convexUrl: options.convexUrl }).pipe(
      Layer.provideMerge(ConvexTransport.layerWebSocket(options.convexUrl)),
      Layer.provide(TokenStorage.layerMemory),
    ),
  );

  const transport = Context.get(sdk, ConvexTransport.ConvexTransport);
  const auth = Context.get(sdk, Auth.Auth);
  const ready = yield* Deferred.make<void>();
  const signedIn = yield* Ref.make(false);
  const generation = yield* Ref.make(0);
  const signingIn = yield* Semaphore.make(1);
  const attempts = yield* Ref.make(0);
  const callTimeout = options.callTimeout ?? DEFAULT_CALL_TIMEOUT;

  const signInOnce = auth
    .signIn(Auth.Credentials.ApiKey({ key: options.apiKey }))
    .pipe(
      Effect.tapError((error) =>
        Ref.updateAndGet(attempts, (count) => count + 1).pipe(
          Effect.flatMap((attempt) =>
            Effect.logWarning("MediaBackend.sign_in_failed", error).pipe(
              Effect.annotateLogs({ attempt }),
            ),
          ),
        ),
      ),
    );

  const signIn = (seen: number) =>
    signingIn.withPermits(1)(
      Effect.gen(function* () {
        if ((yield* Ref.get(generation)) !== seen) return;
        yield* Ref.set(signedIn, false);
        yield* signInOnce.pipe(Effect.retry(backoff), Effect.orDie);
        yield* Ref.set(attempts, 0);
        yield* Ref.update(generation, (current) => current + 1);
        yield* Ref.set(signedIn, true);
        yield* Deferred.succeed(ready, undefined);
        yield* Effect.logInfo("MediaBackend.signed_in");
      }),
    );

  yield* Effect.forkScoped(signIn(0));

  const awaitReady = Deferred.await(ready).pipe(
    Effect.timeoutOrElse({
      duration: READY_WAIT,
      orElse: () =>
        Effect.fail(
          new TransportError({
            operation: "MediaBackend.signIn",
            message: "Transport failed: the media service has not signed in to Convex yet",
            cause: null,
          }),
        ),
    }),
  );

  const callOnce = <Name extends FunctionName>(name: Name, wire: Schema.JsonObject) =>
    transport
      .call(mediaServiceFunctions[name].kind, mediaServiceFunctions[name].function, wire)
      .pipe(
        Effect.timeoutOrElse({
          duration: callTimeout,
          orElse: () =>
            Effect.fail(
              new TransportError({
                operation: name,
                message: `Transport failed: ${name} did not answer within ${String(Duration.toSeconds(callTimeout))} seconds`,
                cause: null,
              }),
            ),
        }),
        Effect.flatMap((raw) => decodeResult(name, raw)),
      );

  const call = <Name extends FunctionName>(
    name: Name,
    args: FunctionArgs<Name>,
  ): Effect.Effect<FunctionResult<Name>, CallError> =>
    Effect.gen(function* () {
      const wire = yield* encodeArgs(name, args);
      yield* awaitReady;
      const seen = yield* Ref.get(generation);

      return yield* callOnce(name, wire).pipe(
        Effect.catchTag("Unauthenticated", () =>
          signIn(seen).pipe(Effect.andThen(callOnce(name, wire))),
        ),
      );
    }).pipe(Effect.withSpan("MediaBackend.call", { attributes: { function: name } }));

  const subscribe = <Name extends QueryName>(
    name: Name,
    args: FunctionArgs<Name>,
  ): Stream.Stream<FunctionResult<Name>> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const wire = yield* encodeArgs(name, args).pipe(Effect.orDie);
        yield* Deferred.await(ready);

        return transport
          .subscribe(mediaServiceFunctions[name].function, wire)
          .pipe(Stream.mapEffect((raw) => decodeResult(name, raw)));
      }),
    ).pipe(
      Stream.tapError((error) =>
        Effect.logWarning("MediaBackend.subscription_failed", error).pipe(
          Effect.annotateLogs({ function: name }),
          Effect.andThen(
            Predicate.isTagged(error, "Unauthenticated")
              ? Ref.get(generation).pipe(Effect.flatMap(signIn))
              : Effect.void,
          ),
        ),
      ),
      Stream.retry(backoff),
      Stream.orDie,
    );

  return Service.of({
    call,
    subscribe,
    status: Ref.get(signedIn).pipe(
      Effect.map((connected) => (connected ? ("connected" as const) : ("connecting" as const))),
    ),
  });
});

/**
 * The connection as a layer, which also reports its state to `GET /api/health`. Fails only when
 * the Convex URL is not valid.
 */
export const layer = (
  options: Options,
): Layer.Layer<Service | BackendHealth.Service, TransportError | TokenStorage.TokenStorageError> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const backend = yield* make(options);

      return Context.make(Service, backend).pipe(
        Context.add(BackendHealth.Service, BackendHealth.Service.of({ status: backend.status })),
      );
    }),
  );
