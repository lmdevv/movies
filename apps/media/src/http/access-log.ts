/**
 * The request log: one DEBUG record per response with its method, status, time taken, and path.
 * Effect's own request logger writes every response at INFO with the full path, so anyone who can
 * reach the port, with or without a token, could fill the retained log and rotate its history out.
 * At DEBUG nothing a caller sends is kept unless `LOG_LEVEL=debug` asks for it. The path loses its
 * query string, which carries playback tokens, and is cut to 128 characters. A handler that died
 * still logs at ERROR with its cause: that is a bug in the service, not traffic.
 */
import { Cause, Clock, Effect, Exit } from "effect";
import {
  HttpServerError,
  HttpServerRequest,
  type HttpServerResponse,
  HttpServerResponse as Response,
} from "effect/http";

const MAX_PATH = 128;

/** `url` without its query or fragment, cut to `MAX_PATH` characters. */
const pathOf = (url: string): string => {
  const path = url.split(/[?#]/u, 1)[0] ?? "";

  return path.length > MAX_PATH ? `${path.slice(0, MAX_PATH)}…` : path;
};

/** Whether `cause` holds a defect other than a response a handler answered with. */
const died = (cause: Cause.Cause<unknown>): boolean =>
  cause.reasons.some(
    (reason) => Cause.isDieReason(reason) && !Response.isHttpServerResponse(reason.defect),
  );

/** Logs each response `httpApp` sends; see the module comment. */
export const accessLog = <E, R>(
  httpApp: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    E,
    HttpServerRequest.HttpServerRequest | R
  >,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  E,
  HttpServerRequest.HttpServerRequest | R
> =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const startedAt = yield* Clock.currentTimeMillis;
    const exit = yield* Effect.exit(httpApp);

    const [response] = Exit.isSuccess(exit)
      ? [exit.value]
      : yield* HttpServerError.causeResponse(exit.cause);

    const annotations = {
      "http.method": request.method,
      "http.url": pathOf(request.url),
      "http.status": response.status,
      elapsedMs: (yield* Clock.currentTimeMillis) - startedAt,
    };

    yield* (
      Exit.isFailure(exit) && died(exit.cause)
        ? Effect.logError("HttpServer.handler_died", exit.cause)
        : Effect.logDebug("HttpServer.response")
    ).pipe(Effect.annotateLogs(annotations));

    return yield* exit;
  });
