/**
 * The HTTP server: the HttpApi control endpoints, the media byte routes, and the web app, with
 * CORS for a separately hosted web app in development. Effect's server spans record full URLs,
 * and media URLs carry playback tokens, so built-in spans are disabled for `/media/` requests;
 * those routes record their own spans without the query string.
 */
import { createServer } from "node:http";

import { NodeHttpServer } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { HttpMiddleware, HttpRouter } from "effect/http";

import * as MediaConfig from "../media-config.ts";
import { apiLayer } from "./api-handlers.ts";
import * as ArtworkRoutes from "./artwork-routes.ts";
import * as MediaRoutes from "./media-routes.ts";
import * as WebApp from "./web-app.ts";

/** Every route the service answers. */
export const routesLayer = Layer.mergeAll(
  apiLayer,
  MediaRoutes.layer,
  ArtworkRoutes.layer,
  WebApp.layer,
  HttpRouter.cors({
    allowedOrigins: ["*"],
    allowedHeaders: ["authorization", "content-type", "range"],
    exposedHeaders: ["content-range", "content-length", "accept-ranges"],
  }),
);

/** Keeps playback tokens in `/media/` URLs out of Effect's automatic server spans. */
export const tokenSafeTracing = Layer.succeed(HttpMiddleware.TracerDisabledWhen)((request) =>
  request.url.startsWith("/media/"),
);

/**
 * Serves the common routes plus `commandRoutes` (route groups of registry `media` commands, which
 * need Convex) on `PORT`.
 */
export const layer = <E, R>(commandRoutes: Layer.Layer<never, E, R>) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const config = yield* MediaConfig.Service;

      return HttpRouter.serve(Layer.mergeAll(routesLayer, commandRoutes)).pipe(
        Layer.provide(tokenSafeTracing),
        Layer.provide(NodeHttpServer.layer(createServer, { port: config.port })),
      );
    }),
  );
