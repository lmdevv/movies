/**
 * Finding a server from the one address someone types into an app: `movies.home.lan`,
 * `192.168.1.20:8080`, `http://nas.tailnet.ts.net:8080`. The address names the media service; it
 * answers `/api/health` and hands out the Convex URL the app signs in with at
 * `/api/client-config`. Native apps keep the result and build their `MoviesProvider` from it.
 */
import {
  ClientConfigResponse,
  HealthResponse,
  MEDIA_ROUTES,
} from "@movies/contracts/media-playback";
import { Duration, Effect, Option, Schema } from "effect";

import { requestPlayback } from "./media-http";

/** Where a found server answers: its media service and the Convex deployment behind it. */
export interface ServerConnection {
  /** The media service's base URL, without a trailing slash. */
  readonly mediaUrl: string;
  /** The Convex deployment URL to sign in with. */
  readonly convexUrl: string;
}

/** The text is not a host name, address, or http(s) URL. */
export class InvalidAddress extends Schema.TaggedError<InvalidAddress>()("InvalidAddress", {
  address: Schema.String,
  message: Schema.String,
}) {}

/** No [movies] media service answered at any URL the address could mean. */
export class ServerUnreachable extends Schema.TaggedError<ServerUnreachable>()(
  "ServerUnreachable",
  { address: Schema.String, message: Schema.String },
) {}

/** A media service answered but has no public Convex URL, so apps cannot sign in through it. */
export class ServerNotReady extends Schema.TaggedError<ServerNotReady>()("ServerNotReady", {
  mediaUrl: Schema.String,
  message: Schema.String,
}) {}

/** Any failure of `lookup`. */
export type LookupError = InvalidAddress | ServerUnreachable | ServerNotReady;

/** The port Compose and the NixOS module serve the media service on by default. */
const DEFAULT_PORT = "8080";

/** How long one candidate URL may take to answer before the next is tried. */
const PROBE_TIMEOUT = Duration.seconds(4);

const SCHEME = /^[a-z][\d+.a-z-]*:\/\//iu;

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/u;

const parseUrl = Option.liftThrowable((text: string) => new URL(text));

/** IP addresses, single-label names, and `.local` names rarely have certificates. */
const plainFirst = (hostname: string): boolean =>
  IPV4.test(hostname) ||
  hostname.startsWith("[") ||
  !hostname.includes(".") ||
  hostname.endsWith(".local");

/**
 * The URLs an address may mean, most likely first; empty when it cannot be one. An address with a
 * scheme means exactly that URL. Without one, IP addresses and local names try `http` first and
 * other names `https`; without a port, Compose's default port comes last. Paths are kept for
 * servers behind a path prefix; queries, fragments, and trailing slashes are dropped.
 */
export const addressCandidates = (address: string): ReadonlyArray<string> => {
  const trimmed = address.trim();

  if (trimmed === "") return [];

  const explicit = SCHEME.test(trimmed);

  return Option.match(parseUrl(explicit ? trimmed : `http://${trimmed}`), {
    onNone: () => [],
    onSome: (url) => {
      if (url.protocol !== "http:" && url.protocol !== "https:") return [];

      if (url.username !== "" || url.password !== "" || url.hostname === "") return [];

      const path = url.pathname.replace(/\/+$/u, "");

      if (explicit) return [`${url.protocol}//${url.host}${path}`];

      const schemes = plainFirst(url.hostname) ? ["http", "https"] : ["https", "http"];
      const candidates = schemes.map((scheme) => `${scheme}://${url.host}${path}`);

      return url.port === ""
        ? [...candidates, `http://${url.hostname}:${DEFAULT_PORT}${path}`]
        : candidates;
    },
  });
};

const get = <A>(mediaUrl: string, route: string, result: Schema.Codec<A, unknown>) =>
  requestPlayback(
    {
      operation: `server.${route}`,
      url: `${mediaUrl}${route}`,
      method: "GET",
      body: Option.none(),
      bearer: Option.none(),
    },
    result,
  );

/** Asks one URL whether it is a media service, and for its client configuration. */
const probe = (mediaUrl: string) =>
  get(mediaUrl, MEDIA_ROUTES.health, HealthResponse).pipe(
    Effect.andThen(get(mediaUrl, MEDIA_ROUTES.clientConfig, ClientConfigResponse)),
    Effect.map((config) => ({ mediaUrl, convexUrl: config.convexUrl })),
    Effect.timeout(PROBE_TIMEOUT),
  );

/**
 * Finds the server `address` names: tries each of its candidate URLs in order and returns the
 * first media service that answers, with the Convex URL to sign in with.
 */
export const lookup = Effect.fn("ServerLookup.lookup")(function* (
  address: string,
): Effect.fn.Return<ServerConnection, LookupError> {
  const candidates = addressCandidates(address);

  if (candidates.length === 0) {
    return yield* new InvalidAddress({
      address,
      message: "Enter a server name or address, such as movies.home.lan.",
    });
  }

  const found = yield* Effect.firstSuccessOf(candidates.map(probe)).pipe(
    Effect.mapError(
      () =>
        new ServerUnreachable({ address, message: "No [movies] server answered at this address." }),
    ),
  );

  if (found.convexUrl === null) {
    return yield* new ServerNotReady({
      mediaUrl: found.mediaUrl,
      message: "This server isn't set up for apps yet.",
    });
  }

  return { mediaUrl: found.mediaUrl, convexUrl: found.convexUrl };
});
