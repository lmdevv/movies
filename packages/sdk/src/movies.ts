/**
 * The SDK assembled: the Convex connection, auth, and the command client in one layer. Clients
 * supply where tokens are stored; everything else comes from the options.
 */
import type { Option } from "effect";
import { Layer } from "effect";

import * as Auth from "./auth";
import * as ConvexTransport from "./convex-transport";
import * as MoviesClient from "./movies-client";
import type { TransportError } from "./sdk-errors";
import type { TokenStorage, TokenStorageError } from "./token-storage";

/** Where the SDK connects and how. */
export interface Options {
  /** The Convex deployment URL. */
  readonly convexUrl: string;
  /** The media service URL for `media` commands; playback uses the URL each session names. */
  readonly mediaUrl: Option.Option<string>;
  /**
   * `websocket` keeps one connection with pushed subscriptions, for apps. `http` makes one-shot
   * requests and polls subscriptions, for short-lived processes such as the CLI.
   */
  readonly connection: "websocket" | "http";
}

/** Everything the SDK provides. */
export type Services = MoviesClient.MoviesClient | Auth.Auth;

/** Opening the SDK can fail when the URL is invalid or stored tokens cannot be read. */
export type OpenError = TransportError | TokenStorageError;

/** Builds the SDK over `transport`. The React entry point passes its own client's transport. */
export const layerWithTransport = (
  options: Pick<Options, "convexUrl" | "mediaUrl">,
): Layer.Layer<Services, TokenStorageError, ConvexTransport.ConvexTransport | TokenStorage> =>
  MoviesClient.layer({ mediaUrl: options.mediaUrl }).pipe(
    Layer.provideMerge(Auth.layer({ convexUrl: options.convexUrl })),
  );

/** The SDK, connecting as `options` says. Requires a token store. */
export const layer = (options: Options): Layer.Layer<Services, OpenError, TokenStorage> =>
  layerWithTransport(options).pipe(
    Layer.provide(
      options.connection === "websocket"
        ? ConvexTransport.layerWebSocket(options.convexUrl)
        : ConvexTransport.layerHttp(options.convexUrl),
    ),
  );
