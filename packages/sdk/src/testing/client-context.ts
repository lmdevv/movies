/**
 * Builds the SDK's command client over a test transport, with real auth and memory token storage
 * (signed out), the way production composes them.
 */
import { Layer, Option } from "effect";

import * as Auth from "../auth";
import * as ConvexTransport from "../convex-transport";
import * as MoviesClient from "../movies-client";
import * as TokenStorage from "../token-storage";

/** The command client and auth over `transport`. Build it with `Layer.build` inside a scope. */
export const clientLayer = (
  transport: ConvexTransport.Interface,
): Layer.Layer<MoviesClient.MoviesClient | Auth.Auth, TokenStorage.TokenStorageError> =>
  MoviesClient.layer({ mediaUrl: Option.none() }).pipe(
    Layer.provideMerge(Auth.layer({ convexUrl: "http://127.0.0.1:9" })),
    Layer.provide(TokenStorage.layerMemory),
    Layer.provide(Layer.succeed(ConvexTransport.ConvexTransport, transport)),
  );
