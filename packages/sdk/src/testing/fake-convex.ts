/**
 * A fake Convex deployment that speaks the HTTP protocol `ConvexHttpClient` uses: `POST
 * /api/query`, `/api/mutation`, and `/api/action` with a JSON body of `{ path, format, args: [args]
 * }`, answered with `{ status: "success", value }` or, with status 560, `{ status: "error",
 * errorMessage, errorData }`. Convex rejecting the auth token itself is a 401 whose text body is `{
 * code, message }`. Tests script replies per function path and read back every request with its
 * arguments and `Authorization` header. Unscripted functions answer the way Convex answers an
 * unknown function: a server error.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";

import type { ErrorCode } from "@movies/contracts/errors";
import { Data, Effect, Option, Predicate, Schema } from "effect";
import type { Scope } from "effect";

/** How a recorded call ran, from the endpoint it reached. */
type CallKind = "query" | "mutation" | "action";

/** One function call the fake received. */
interface RecordedRequest {
  readonly kind: CallKind;
  /** The Convex function path, such as `auth:signIn`. */
  readonly path: string;
  readonly args: Schema.Json;
  /** The raw `Authorization` header, such as `Bearer <jwt>`; undefined when signed out. */
  readonly authorization: string | undefined;
}

/** What the fake answers a call with. */
export type Reply = Data.TaggedEnum<{
  /** The function returned `value`. */
  Success: { readonly value: Schema.Json };
  /** The function threw `ConvexError({ code, message })`. */
  Failure: { readonly code: ErrorCode; readonly message: string };
  /** The function crashed with an uncaught error. */
  Crash: { readonly message: string };
  /** Convex could not verify the auth token and ran nothing. */
  TokenRejected: {};
  /** The connection drops before any answer, as when the server is unreachable. */
  Drop: {};
}>;

/** Constructors for `Reply`. */
export const Reply = Data.taggedEnum<Reply>();

/** Answers one call; it may wait on test-controlled signals before answering. */
type Handler = (request: RecordedRequest) => Effect.Effect<Reply>;

/** The fake deployment and its test controls. */
export interface FakeConvex {
  /** The deployment URL to hand the SDK. */
  readonly url: string;
  /** Answers every later call to `path` with `handler`, replacing any earlier one. */
  readonly handle: (path: string, handler: Handler) => Effect.Effect<void>;
  /** Answers every later call to `path` with `reply`. */
  readonly reply: (path: string, reply: Reply) => Effect.Effect<void>;
  /** Every call received so far, in arrival order. */
  readonly requests: Effect.Effect<ReadonlyArray<RecordedRequest>>;
  /** The calls received so far to `path`. */
  readonly requestsTo: (path: string) => Effect.Effect<ReadonlyArray<RecordedRequest>>;
}

const RequestBody = Schema.fromJsonString(
  Schema.Struct({ path: Schema.String, args: Schema.Array(Schema.Json) }),
);

const decodeBody = Schema.decodeUnknownOption(RequestBody);

/** The call kind an endpoint serves; undefined for any other URL. */
const kindOf = (url: string | undefined): CallKind | undefined => {
  if (url === "/api/query") return "query";

  if (url === "/api/mutation") return "mutation";

  return url === "/api/action" ? "action" : undefined;
};

/** The status Convex uses for a function that ran and failed. */
const FUNCTION_FAILED = 560;

const send = (response: ServerResponse, status: number, body: string): void => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(body);
};

const write = (response: ServerResponse, reply: Reply): void =>
  Reply.$match(reply, {
    Success: ({ value }) =>
      send(response, 200, JSON.stringify({ status: "success", value, logLines: [] })),
    Failure: ({ code, message }) =>
      send(
        response,
        FUNCTION_FAILED,
        JSON.stringify({
          status: "error",
          errorMessage: message,
          errorData: { code, message },
          logLines: [],
        }),
      ),
    Crash: ({ message }) =>
      send(
        response,
        FUNCTION_FAILED,
        JSON.stringify({
          status: "error",
          errorMessage: `[Request ID: fake] Server Error\nUncaught Error: ${message}`,
          logLines: [],
        }),
      ),
    TokenRejected: () =>
      send(
        response,
        401,
        JSON.stringify({ code: "Unauthenticated", message: "Could not verify OIDC token claim" }),
      ),
    Drop: () => {
      response.socket?.destroy();
    },
  });

const jwtPart = (value: Schema.Json): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

/** A JWT that only carries `exp`, enough for the SDK to read when it expires. */
export const jwtExpiringAt = (epochMillis: number, subject = "user"): string =>
  `${jwtPart({ alg: "none" })}.${jwtPart({ exp: Math.floor(epochMillis / 1000), sub: subject })}.fake`;

/** Starts the fake on a free local port; it stops when the scope closes. */
export const make: Effect.Effect<FakeConvex, never, Scope.Scope> = Effect.gen(function* () {
  const context = yield* Effect.context();
  const handlers = new Map<string, Handler>();
  const received: Array<RecordedRequest> = [];

  const answer = (request: RecordedRequest): Effect.Effect<Reply> =>
    Option.match(Option.fromNullishOr(handlers.get(request.path)), {
      onNone: () =>
        Effect.succeed(
          Reply.Crash({ message: `Could not find public function for '${request.path}'` }),
        ),
      onSome: (handler) => handler(request),
    });

  const server = createServer((incoming: IncomingMessage, response: ServerResponse) => {
    let text = "";

    incoming.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
    });

    incoming.on("end", () => {
      const kind = kindOf(incoming.url);
      const body = decodeBody(text);

      if (kind === undefined || Option.isNone(body)) {
        send(response, 404, "Not found");

        return;
      }

      const request: RecordedRequest = {
        kind,
        path: body.value.path,
        args: body.value.args[0] ?? null,
        authorization: incoming.headers.authorization,
      };

      received.push(request);

      void Effect.runPromiseWith(context)(answer(request)).then(
        (reply) => write(response, reply),
        (cause: unknown) => write(response, Reply.Crash({ message: String(cause) })),
      );
    });
  });

  const port = yield* Effect.acquireRelease(
    Effect.callback<number>((resume) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();

        resume(
          address === null || Predicate.isString(address)
            ? Effect.die(new Error("The fake Convex server is not on TCP"))
            : Effect.succeed(address.port),
        );
      });
    }),
    () =>
      Effect.callback<void>((resume) => {
        server.closeAllConnections();
        server.close(() => resume(Effect.void));
      }),
  );

  return {
    url: `http://127.0.0.1:${String(port)}`,
    handle: (path, handler) =>
      Effect.sync(() => {
        handlers.set(path, handler);
      }),
    reply: (path, reply) =>
      Effect.sync(() => {
        handlers.set(path, () => Effect.succeed(reply));
      }),
    requests: Effect.sync(() => [...received]),
    requestsTo: (path) => Effect.sync(() => received.filter((request) => request.path === path)),
  };
});
