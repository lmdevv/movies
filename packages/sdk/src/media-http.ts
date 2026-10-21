/**
 * JSON requests to the media service. Effect's HttpClient is an unstable module, which the repo's
 * lint rejects in the SDK, so this boundary uses the platform's `fetch`, available in browsers,
 * Node, and React Native alike. It owns status classification, body decoding, and failure
 * translation for both kinds of media service routes:
 *
 * - registry `media` commands answer failures with the same `{ code, message }` body as Convex
 *   (`requestJson`);
 * - the playback API answers with the tagged errors of `@movies/contracts/media-playback`
 *   (`requestPlayback`), so clients can tell a stale playlist from an expired token;
 * - the retained log answers with NDJSON lines as they come (`requestLines`), and failures like
 *   registry commands.
 */
import { CommandFailure, commandError } from "@movies/contracts/errors";
import type { CommandError, ErrorCode } from "@movies/contracts/errors";
import { PlaybackApiError } from "@movies/contracts/media-playback";
import type { StartedPlayback } from "@movies/contracts/models/playback";
import { Context, Effect, Option, Redacted, Schema, Stream } from "effect";

import type { CallError } from "./sdk-errors";
import { ProtocolError, TransportError } from "./sdk-errors";

/**
 * Where this client sends playback API requests, when not to the public URL a started session
 * names (`mediaBaseUrl`). A client that reaches the media service at an address its viewers
 * cannot, such as the CLI inside the server's container at `http://127.0.0.1:8080`, provides its
 * configured media URL here. The URLs the service answers with, such as `stream.url`, still use
 * the service's public URL, so they stay the ones to hand a player. None (the default) sends
 * requests to the session's URL.
 */
export const MediaOrigin = Context.Reference<Option.Option<string>>("@movies/sdk/MediaOrigin", {
  defaultValue: Option.none,
});

/** Strips a trailing slash so routes join cleanly. */
export const baseUrl = (url: string): string => url.replace(/\/+$/u, "");

/** `path` on the media service of a started session, at `MediaOrigin` when one is provided. */
export const mediaUrl = (
  started: { readonly mediaBaseUrl: string },
  path: string,
): Effect.Effect<string> =>
  Effect.gen(function* () {
    const origin = Option.getOrElse(yield* MediaOrigin, () => started.mediaBaseUrl);

    return `${baseUrl(origin)}${path}`;
  });

/** `value` as the JSON its schema's JSON codec writes, for a request body. */
export const encodeJson = <A, I>(
  schema: Schema.Codec<A, I>,
  value: A,
): Effect.Effect<Schema.Json> =>
  Schema.encodeEffect(Schema.toCodecJson(schema))(value).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Json)),
    // The request schemas only hold JSON values; failing to encode one is a defect.
    Effect.orDie,
  );

/** `started` with a token `playback.renewToken` signed for it. */
export const withRenewedToken = (
  started: StartedPlayback,
  renewed: Pick<StartedPlayback, "token" | "tokenExpiresAt">,
): StartedPlayback => ({
  sessionId: started.sessionId,
  titleId: started.titleId,
  episodeId: started.episodeId,
  episode: started.episode,
  file: started.file,
  token: renewed.token,
  tokenExpiresAt: renewed.tokenExpiresAt,
  mediaBaseUrl: started.mediaBaseUrl,
  resumePositionMs: started.resumePositionMs,
});

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

/** A failure body that carries a tag but no command code: the tag, read into `tag`. */
const TaggedFailure = Schema.Struct({ tag: Schema.String }).pipe(
  Schema.encodeKeys({ tag: "_tag" }),
);

const decodeCommandFailure = Schema.decodeUnknownOption(CommandFailure);

const decodeTaggedFailure = Schema.decodeUnknownOption(TaggedFailure);

const decodePlaybackFailure = Schema.decodeUnknownOption(Schema.toCodecJson(PlaybackApiError));

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

/** Statuses a reverse proxy answers when the media service itself is down. */
const GATEWAY_STATUSES: ReadonlySet<number> = new Set([502, 504]);

/** An answered request: its status and decoded JSON body (null when empty). */
interface MediaResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly body: Schema.Json;
}

const readJson = (
  request: MediaRequest,
  response: Response,
): Effect.Effect<Schema.Json, TransportError | ProtocolError> =>
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
 * Sends `request`, accepting `accept`, and answers with the response once its headers arrive.
 * Network failures and gateway answers become `TransportError`.
 */
const fetchResponse = (
  request: MediaRequest,
  accept: string,
): Effect.Effect<Response, TransportError> =>
  Effect.gen(function* () {
    const headers = new Headers({ accept });

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

    if (GATEWAY_STATUSES.has(response.status)) {
      return yield* new TransportError({
        operation: request.operation,
        message: `Transport failed during ${request.operation}: the media service is unreachable (HTTP ${String(response.status)})`,
        cause: null,
      });
    }

    return response;
  });

/** Sends `request` and reads its JSON body. Network failures become `TransportError`. */
const send = (
  request: MediaRequest,
): Effect.Effect<MediaResponse, TransportError | ProtocolError> =>
  Effect.gen(function* () {
    const response = yield* fetchResponse(request, "application/json");

    return { status: response.status, ok: response.ok, body: yield* readJson(request, response) };
  });

/** Classifies a failed command response from its status and decoded body. */
const commandFailureOf = (request: MediaRequest, response: MediaResponse): CommandError => {
  const known = decodeCommandFailure(response.body);

  if (Option.isSome(known)) return commandError(known.value);

  const reason = Option.match(decodeTaggedFailure(response.body), {
    onNone: () => `HTTP ${String(response.status)}`,
    onSome: (tagged) => tagged.tag,
  });

  return commandError({
    code: STATUS_CODES.get(response.status) ?? "internal",
    message: `The media service refused ${request.operation}: ${reason}`,
  });
};

const decodeSuccess = <A>(
  request: MediaRequest,
  result: Schema.Codec<A, unknown>,
  body: Schema.Json,
): Effect.Effect<A, ProtocolError> =>
  Schema.decodeEffect(result)(body).pipe(
    Effect.mapError(
      (cause) =>
        new ProtocolError({
          operation: request.operation,
          message: `Protocol error in ${request.operation}: unexpected media service response`,
          cause,
        }),
    ),
  );

/**
 * Sends a registry `media` command and decodes a successful body with `result`. Non-2xx answers
 * become command errors; network failures become `TransportError`; bodies that do not match
 * become `ProtocolError`.
 */
export const requestJson = <A>(
  request: MediaRequest,
  result: Schema.Codec<A, unknown>,
): Effect.Effect<A, CallError> =>
  Effect.gen(function* () {
    const response = yield* send(request);

    if (!response.ok) return yield* commandFailureOf(request, response);

    return yield* decodeSuccess(request, result, response.body);
  }).pipe(Effect.withSpan("MediaHttp.request", { attributes: { operation: request.operation } }));

/** An answer streamed line by line: its headers, then its lines as they arrive. */
export interface LineResponse {
  readonly headers: Headers;
  /** The body's lines, without line ends; failing with `TransportError` if the body is cut off. */
  readonly lines: Stream.Stream<string, TransportError>;
}

/**
 * Sends a request whose answer is NDJSON, such as the retained log, and answers once its headers
 * arrive. Failures are registry command errors, as for `requestJson`. Ending or interrupting the
 * lines cancels the body, which closes the connection.
 */
export const requestLines = (request: MediaRequest): Effect.Effect<LineResponse, CallError> =>
  Effect.gen(function* () {
    const response = yield* fetchResponse(request, "application/x-ndjson");

    if (!response.ok) {
      const body = yield* readJson(request, response);

      return yield* commandFailureOf(request, { status: response.status, ok: false, body });
    }

    const lines = Stream.fromReadableStream({
      evaluate: () => response.body ?? new ReadableStream<Uint8Array>(),
      onError: (cause) =>
        new TransportError({
          operation: request.operation,
          message: `Transport failed during ${request.operation}: the stream was cut off`,
          cause,
        }),
    }).pipe(Stream.decodeText(), Stream.splitLines);

    const answer: LineResponse = { headers: response.headers, lines };

    return answer;
  }).pipe(Effect.withSpan("MediaHttp.lines", { attributes: { operation: request.operation } }));

/** Any failure of a playback API call. */
export type PlaybackCallError = PlaybackApiError | TransportError | ProtocolError;

/**
 * Sends a playback API request and decodes a successful body with `result`. Failures decode into
 * the playback API's tagged errors; a failure body outside that contract is a `ProtocolError`.
 */
export const requestPlayback = <A>(
  request: MediaRequest,
  result: Schema.Codec<A, unknown>,
): Effect.Effect<A, PlaybackCallError> =>
  Effect.gen(function* () {
    const response = yield* send(request);

    // The playback API encodes with each schema's JSON codec (absent optional fields as null).
    if (response.ok)
      return yield* decodeSuccess(request, Schema.toCodecJson(result), response.body);

    const failure = decodePlaybackFailure(response.body);

    if (Option.isSome(failure)) return yield* failure.value;

    return yield* new ProtocolError({
      operation: request.operation,
      message: `Protocol error in ${request.operation}: the media service failed with HTTP ${String(response.status)} and an unknown body`,
      cause: response.body,
    });
  }).pipe(Effect.withSpan("MediaHttp.playback", { attributes: { operation: request.operation } }));
