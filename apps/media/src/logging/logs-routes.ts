/**
 * `POST /api/logs`: the retained log for admins, as NDJSON. The body is a `LogQuery`, and the
 * caller's Convex auth token must hold the `admin` scope. Without `follow` the answer ends after
 * the last matching record; with it, new matching records stream until the caller disconnects,
 * and a blank line every 15 seconds keeps idle proxies from closing the connection.
 *
 * NDJSON over a plain chunked response rather than server-sent events: it is the files' own
 * format, so the CLI passes lines through untouched, and `fetch` sends the bearer token, which a
 * browser's `EventSource` cannot.
 */
import { DIAGNOSTICS_ROUTES, LOG_TRUNCATED_HEADER, LogQuery } from "@movies/contracts/diagnostics";
import { InvalidArgs } from "@movies/contracts/errors";
import { Duration, Effect, FileSystem, Layer, Path, Schema, Stream } from "effect";
import { HttpEffect, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as ViewerAuth from "../convex/viewer-auth.ts";
import { bearerOf, failureResponse, issueText } from "../http/command-routes.ts";
import * as LogReader from "./log-reader.ts";
import * as RetainedLogs from "./retained-logs.ts";

const decodeQuery = Schema.decodeUnknownEffect(Schema.toCodecJson(LogQuery));

/** How often a followed log with nothing new sends a blank line. */
const KEEPALIVE = Duration.seconds(15);

/** Adds the route. */
export const layer: Layer.Layer<
  never,
  never,
  | HttpRouter.HttpRouter
  | ViewerAuth.Service
  | RetainedLogs.Service
  | FileSystem.FileSystem
  | Path.Path
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const router = yield* HttpRouter.HttpRouter;
    const auth = yield* ViewerAuth.Service;
    const retained = yield* RetainedLogs.Service;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const route = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;

      yield* auth.authorize(yield* bearerOf(request), "admin");

      const body = yield* request.json.pipe(
        Effect.mapError(() => new InvalidArgs({ message: "The body is not JSON" })),
      );

      const query = yield* decodeQuery(body).pipe(
        Effect.mapError(
          (error) => new InvalidArgs({ message: `Invalid log query: ${issueText(error.issue)}` }),
        ),
      );

      if (query.follow === true && query.until !== undefined) {
        return yield* new InvalidArgs({ message: "A followed log has no end: drop until" });
      }

      const found = yield* LogReader.read(query).pipe(
        Effect.provideService(RetainedLogs.Service, retained),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );

      const keepalive = Stream.tick(KEEPALIVE).pipe(
        Stream.drop(1),
        Stream.map(() => ""),
      );

      const lines = Stream.fromIterable(found.matches.map((match) => match.line)).pipe(
        Stream.concat(query.follow === true ? Stream.merge(found.live, keepalive) : Stream.empty),
        Stream.map((line) => `${line}\n`),
        Stream.encodeText,
      );

      return HttpEffect.scopeTransferToStream(
        HttpServerResponse.stream(lines, {
          contentType: "application/x-ndjson",
          headers: {
            "cache-control": "no-store",
            [LOG_TRUNCATED_HEADER]: String(found.truncated),
          },
        }),
      );
    }).pipe(
      Effect.catch((error) => Effect.succeed(failureResponse(error))),
      Effect.withSpan("LogsRoute.read"),
    );

    yield* router.add("POST", DIAGNOSTICS_ROUTES.logs, route);
  }),
);
