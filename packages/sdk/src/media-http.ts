/**
 * JSON requests to the media service. Effect's HttpClient is an unstable module, which the repo's
 * lint rejects, so this boundary uses the platform's `fetch`, available in browsers, Node, and
 * React Native alike. It owns status classification, body decoding, and failure translation.
 *
 * Registry `media` commands answer failures with the same `{ code, message }` body as Convex. The
 * playback routes are an Effect HttpApi whose failures carry a `_tag`; those map onto the closest
 * command error by status until the HttpApi's errors move into the contracts.
 */
import { CommandFailure, commandError } from "@movies/contracts/errors";
import type { CommandError, ErrorCode } from "@movies/contracts/errors";
import { Effect, Option, Redacted, Schema } from "effect";

import type { CallError } from "./sdk-errors";
import { ProtocolError, TransportError } from "./sdk-errors";

/** One request to the media service. */
export interface MediaRequest {
  /** What the request does, for errors and traces, such as `playback.negotiate`. */
  readonly operation: string;
  readonly url: string;
  readonly method: "GET" | "POST";
  /** The JSON body; none for requests without one. */
  readonly body: Option.Option<Schema.Json>;
  /** The caller's Convex auth token, sent as a bearer token. */
  readonly bearer: Option.Option<Redacted.Redacted>;
}

/** An HttpApi failure body: the error's tag, read into `tag`. */
const TaggedFailure = Schema.Struct({ tag: Schema.String }).pipe(
  Schema.encodeKeys({ tag: "_tag" }),
);

const decodeCommandFailure = Schema.decodeUnknownOption(CommandFailure);

const decodeTaggedFailure = Schema.decodeUnknownOption(TaggedFailure);

const decodeJsonText = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json));

/** The command error code closest to an HTTP status without a `{ code, message }` body. */
const STATUS_CODES: ReadonlyMap<number, ErrorCode> = new Map([
  [400, "invalid_args"],
  [401, "unauthenticated"],
  [403, "forbidden"],
  [404, "not_found"],
  [409, "conflict"],
  [410, "expired"],
  [422, "invalid_args"],
  [429, "rate_limited"],
  [503, "rate_limited"],
  [507, "rate_limited"],
]);

/** Classifies a failed response from its status and decoded body. */
const failureOf = (request: MediaRequest, status: number, body: Schema.Json): CommandError => {
  const known = decodeCommandFailure(body);

  if (Option.isSome(known)) return commandError(known.value);

  const reason = Option.match(decodeTaggedFailure(body), {
    onNone: () => `HTTP ${String(status)}`,
    onSome: (tagged) => tagged.tag,
  });

  return commandError({
    code: STATUS_CODES.get(status) ?? "internal",
    message: `The media service refused ${request.operation}: ${reason}`,
  });
};

const readJson = (
  request: MediaRequest,
  response: Response,
): Effect.Effect<Schema.Json, CallError> =>
  Effect.tryPromise({
    try: () => response.text(),
    catch: (cause) =>
      new TransportError({
        operation: request.operation,
        message: `Transport failed during ${request.operation}: the response body was cut off`,
        cause,
      }),
  }).pipe(
    Effect.flatMap((text) =>
      text.length === 0
        ? Effect.succeed<Schema.Json>(null)
        : decodeJsonText(text).pipe(
            Effect.mapError(
              (cause) =>
                new ProtocolError({
                  operation: request.operation,
                  message: `Protocol error in ${request.operation}: the media service sent a body that is not JSON`,
                  cause,
                }),
            ),
          ),
    ),
  );

/**
 * Sends `request` and decodes a successful body with `result`. Non-2xx answers become command
 * errors; network failures become `TransportError`; bodies that do not match become
 * `ProtocolError`.
 */
export const requestJson = <A>(
  request: MediaRequest,
  result: Schema.Codec<A, unknown>,
): Effect.Effect<A, CallError> =>
  Effect.gen(function* () {
    const headers = new Headers({ accept: "application/json" });

    if (Option.isSome(request.body)) headers.set("content-type", "application/json");

    if (Option.isSome(request.bearer)) {
      headers.set("authorization", `Bearer ${Redacted.value(request.bearer.value)}`);
    }

    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(request.url, {
          method: request.method,
          headers,
          signal,
          ...Option.match(request.body, {
            onNone: () => ({}),
            onSome: (body) => ({ body: JSON.stringify(body) }),
          }),
        }),
      catch: (cause) =>
        new TransportError({
          operation: request.operation,
          message: `Transport failed during ${request.operation}: the media service is unreachable`,
          cause,
        }),
    });

    const body = yield* readJson(request, response);

    if (!response.ok) return yield* failureOf(request, response.status, body);

    return yield* Schema.decodeEffect(result)(body).pipe(
      Effect.mapError(
        (cause) =>
          new ProtocolError({
            operation: request.operation,
            message: `Protocol error in ${request.operation}: unexpected media service response`,
            cause,
          }),
      ),
    );
  }).pipe(Effect.withSpan("MediaHttp.request", { attributes: { operation: request.operation } }));
