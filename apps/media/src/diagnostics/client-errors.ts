/**
 * `POST /api/client-errors`: an app's unexpected error, written to the retained log at `WARN` as
 * `Client.error`. The caller's Convex auth token must belong to a signed-in session, and each
 * account has a budget, so a crash loop cannot rotate the log's history out.
 */
import { ClientErrorReport, DIAGNOSTICS_ROUTES } from "@movies/contracts/diagnostics";
import { InvalidArgs, RateLimited } from "@movies/contracts/errors";
import type { Viewer } from "@movies/contracts/models/account";
import { Clock, Effect, Layer, Option, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as ViewerAuth from "../convex/viewer-auth.ts";
import { bearerOf, failureResponse, issueText } from "../http/command-routes.ts";
import { makeLimiter } from "../http/rate-limit.ts";

const ACCOUNT_BUDGET = { burst: 20, perSecond: 0.1 };

const decodeReport = Schema.decodeUnknownEffect(Schema.toCodecJson(ClientErrorReport));

const annotationsOf = (report: ClientErrorReport, viewer: Viewer) => ({
  source: "client",
  userId: viewer.user.id,
  platform: report.platform,
  appVersion: report.appVersion,
  kind: report.kind,
  route: report.route,
  errorName: report.name,
  errorMessage: report.message,
  stack: report.stack ?? null,
  failedRequestId: report.requestId ?? null,
  claimedSessionId: report.sessionId ?? null,
});

/** Adds the route. */
export const layer: Layer.Layer<never, never, HttpRouter.HttpRouter | ViewerAuth.Service> =
  Layer.effectDiscard(
    Effect.gen(function* () {
      const router = yield* HttpRouter.HttpRouter;
      const auth = yield* ViewerAuth.Service;
      const take = makeLimiter();

      const route = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const viewer = yield* auth.authorize(yield* bearerOf(request), "authenticated");
        const wait = take([[viewer.user.id, ACCOUNT_BUDGET]], yield* Clock.currentTimeMillis);

        if (Option.isSome(wait)) {
          return yield* new RateLimited({
            message: `Too many error reports: try again in ${String(wait.value)} s`,
            retryAfterSeconds: wait.value,
          });
        }

        const body = yield* request.json.pipe(
          Effect.mapError(() => new InvalidArgs({ message: "The body is not JSON" })),
        );

        const report = yield* decodeReport(body).pipe(
          Effect.mapError(
            (error) =>
              new InvalidArgs({ message: `Invalid error report: ${issueText(error.issue)}` }),
          ),
        );

        yield* Effect.logWarning("Client.error").pipe(
          Effect.annotateLogs(annotationsOf(report, viewer)),
        );

        return HttpServerResponse.empty({ status: 204 });
      }).pipe(
        Effect.catch((error) => Effect.succeed(failureResponse(error))),
        Effect.withSpan("ClientErrors.report"),
      );

      yield* router.add("POST", DIAGNOSTICS_ROUTES.clientErrors, route);
    }),
  );
