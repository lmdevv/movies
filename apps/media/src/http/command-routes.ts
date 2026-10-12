/**
 * Registry `media` commands over HTTP (`@movies/contracts/commands`, kind `media`): each answers
 * at its command's route, takes the command's arguments as a JSON body, and requires the caller's
 * Convex auth token as a bearer token holding the command's scope. Results are encoded with the
 * command's result schema; expected failures answer `{ code, message }` with the status of their
 * code, the same body Convex uses, so clients handle both alike.
 *
 * Route groups register their commands with `commandRoute`; see `metadata-routes.ts`.
 */
import type { CommandArgs, CommandResult } from "@movies/contracts/commands";
import { commands } from "@movies/contracts/commands";
import type { CommandNameOfKind } from "@movies/contracts/commands";
import { type CommandError, InvalidArgs, Unauthenticated } from "@movies/contracts/errors";
import type { Viewer } from "@movies/contracts/models/account";
import type { CallError } from "@movies/sdk/effect";
import { Effect, Match, Redacted, Schema, SchemaIssue } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as ViewerAuth from "../convex/viewer-auth.ts";

/** Commands the media service serves. */
export type MediaCommandName = CommandNameOfKind<"media">;

/** Implements one media command for an authorized viewer. */
export type CommandHandler<Name extends MediaCommandName> = (
  args: CommandArgs<Name>,
  viewer: Viewer,
) => Effect.Effect<CommandResult<Name>, CallError>;

/** The wire code and HTTP status of each failure. */
const failureOf = Match.type<CallError>().pipe(
  Match.tagsExhaustive({
    Unauthenticated: (error) => ({ code: "unauthenticated", status: 401, message: error.message }),
    Forbidden: (error) => ({ code: "forbidden", status: 403, message: error.message }),
    NotFound: (error) => ({ code: "not_found", status: 404, message: error.message }),
    InvalidArgs: (error) => ({ code: "invalid_args", status: 400, message: error.message }),
    Conflict: (error) => ({ code: "conflict", status: 409, message: error.message }),
    Expired: (error) => ({ code: "expired", status: 410, message: error.message }),
    StaleRevision: (error) => ({ code: "stale_revision", status: 409, message: error.message }),
    RateLimited: (error) => ({ code: "rate_limited", status: 429, message: error.message }),
    Internal: (error) => ({ code: "internal", status: 500, message: error.message }),
    TransportError: () => ({
      code: "internal",
      status: 503,
      message: "The media service could not reach Convex",
    }),
    ProtocolError: () => ({
      code: "internal",
      status: 502,
      message: "Convex answered with something the media service does not understand",
    }),
  }),
);

const failureResponse = (error: CallError): HttpServerResponse.HttpServerResponse => {
  const { code, status, message } = failureOf(error);

  return HttpServerResponse.jsonUnsafe(
    { code, message },
    { status, headers: { "cache-control": "no-store" } },
  );
};

const BEARER = /^Bearer\s+(\S+)$/iu;

const bearerOf = (request: HttpServerRequest.HttpServerRequest) => {
  const match = BEARER.exec(request.headers["authorization"] ?? "");
  const token = match?.[1];

  return token === undefined
    ? Effect.fail<CommandError>(
        new Unauthenticated({ message: "Send the session's Convex auth token as a bearer token" }),
      )
    : Effect.succeed(Redacted.make(token));
};

const issueText = (issue: SchemaIssue.Issue): string =>
  SchemaIssue.makeFormatterDefault()(issue).replaceAll("\n", " ");

/** Registers `handler` at the route of the media command `name`. */
export const commandRoute = Effect.fnUntraced(function* <Name extends MediaCommandName>(
  name: Name,
  handler: CommandHandler<Name>,
) {
  const router = yield* HttpRouter.HttpRouter;
  const auth = yield* ViewerAuth.Service;
  const command = commands[name];
  const decodeArgs = Schema.decodeUnknownEffect(Schema.toCodecJson(command.args));
  const encodeResult = Schema.encodeEffect(Schema.toCodecJson(command.result));

  const route = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const viewer = yield* auth.authorize(yield* bearerOf(request), command.scope);

    const body = yield* request.json.pipe(
      Effect.mapError(() => new InvalidArgs({ message: "The body is not JSON" })),
    );

    const args = yield* decodeArgs(body).pipe(
      Effect.mapError(
        (error) =>
          new InvalidArgs({ message: `Invalid arguments for ${name}: ${issueText(error.issue)}` }),
      ),
    );

    const result = yield* handler(args, viewer);
    const encoded = yield* encodeResult(result).pipe(Effect.orDie);

    return HttpServerResponse.jsonUnsafe(encoded, { headers: { "cache-control": "no-store" } });
  }).pipe(
    Effect.catch((error) => Effect.succeed(failureResponse(error))),
    Effect.withSpan("CommandRoutes.command", { attributes: { command: name } }),
  );

  yield* router.add(command.route.method, command.route.path, route);
});
