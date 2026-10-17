/**
 * Finding the server this app talks to: the media service people type in (it also serves the web
 * app and artwork) and the Convex deployment accounts live on. Typing only the media address is
 * enough; the media service answers with the Convex URL at `/api/client-config`.
 */
import {
  ClientConfigResponse,
  HealthResponse,
  MEDIA_ROUTES,
} from "@movies/contracts/media-playback";
import { Option, Schema } from "effect";

/** Where this install connects. */
export interface ServerConnection {
  /** The media service, such as `https://cinema.home`. */
  readonly mediaUrl: string;
  /** The Convex deployment, such as `https://accounts.cinema.home`. */
  readonly convexUrl: string;
}

/** Why connecting to an address failed. */
export type ConnectFailure =
  /** The text is not an address. */
  | "invalid"
  /** Nothing answered, or it answered but is not a [movies] media service. */
  | "unreachable"
  /** A [movies] server that runs without accounts, so this app cannot sign in to it. */
  | "standalone";

const hasSchemePrefix = /^[a-z][a-z\d+.-]*:\/\//iu;

/**
 * Turns typed text into a base URL: trims it, adds `https://` when no scheme is given, and drops
 * trailing slashes. Null when it is not an http or https URL.
 */
export const normalizeServerUrl = (text: string): string | null => {
  const trimmed = text.trim();

  if (trimmed === "") return null;

  const withScheme = hasSchemePrefix.test(trimmed) ? trimmed : `https://${trimmed}`;

  try {
    const url = new URL(withScheme);

    if (url.protocol !== "http:" && url.protocol !== "https:") return null;

    return `${url.origin}${url.pathname}`.replace(/\/+$/u, "");
  } catch {
    return null;
  }
};

const TIMEOUT_MS = 8000;

/**
 * Fetches `url` and decodes its JSON body with `schema`'s JSON codec, as the media service encodes
 * it; none when the request fails, times out, or the body does not decode.
 */
const getDecoded = async <A>(
  url: string,
  schema: Schema.Codec<A, unknown>,
): Promise<Option.Option<A>> => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });

    return response.ok
      ? Schema.decodeUnknownOption(Schema.toCodecJson(schema))(await response.json())
      : Option.none();
  } catch {
    return Option.none();
  }
};

/** What connecting to an address found. */
export type ConnectResult =
  | { readonly ok: true; readonly connection: ServerConnection }
  | { readonly ok: false; readonly failure: ConnectFailure };

/** Asks one media service base URL where accounts live. */
const discoverAt = async (mediaUrl: string): Promise<ConnectResult> => {
  const health = await getDecoded(`${mediaUrl}${MEDIA_ROUTES.health}`, HealthResponse);

  if (Option.isNone(health)) return { ok: false, failure: "unreachable" };

  const config = await getDecoded(`${mediaUrl}${MEDIA_ROUTES.clientConfig}`, ClientConfigResponse);
  const convexUrl = Option.flatMapNullishOr(config, (value) => value.convexUrl);

  return Option.isNone(convexUrl)
    ? { ok: false, failure: "standalone" }
    : { ok: true, connection: { mediaUrl, convexUrl: convexUrl.value } };
};

const hasScheme = (text: string): boolean => hasSchemePrefix.test(text.trim());

/**
 * Checks that `text` is a [movies] media service and asks it where accounts live. An address
 * typed without a scheme tries `https://` first, then `http://`, the way home servers often run.
 */
export const discoverServer = async (text: string): Promise<ConnectResult> => {
  const normalized = normalizeServerUrl(text);

  if (normalized === null) return { ok: false, failure: "invalid" };

  const secure = await discoverAt(normalized);

  if (secure.ok || secure.failure !== "unreachable" || hasScheme(text)) return secure;

  return discoverAt(normalized.replace(/^https:/u, "http:"));
};

/**
 * Checks both addresses typed on Connection Details: the media service must answer its health
 * check and the account server its version endpoint.
 */
export const connectManually = async (
  mediaText: string,
  convexText: string,
): Promise<ConnectResult> => {
  const mediaUrl = normalizeServerUrl(mediaText);
  const convexUrl = normalizeServerUrl(convexText);

  if (mediaUrl === null || convexUrl === null) return { ok: false, failure: "invalid" };

  const health = await getDecoded(`${mediaUrl}${MEDIA_ROUTES.health}`, HealthResponse);

  if (Option.isNone(health)) return { ok: false, failure: "unreachable" };

  try {
    const version = await fetch(`${convexUrl}/version`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    return version.ok
      ? { ok: true, connection: { mediaUrl, convexUrl } }
      : { ok: false, failure: "unreachable" };
  } catch {
    return { ok: false, failure: "unreachable" };
  }
};

const FAILURE_LINES = {
  invalid: "Enter a server address, such as https://cinema.home.",
  unreachable: "Can't reach a [movies] server at that address.",
  standalone: "This server runs without accounts. Enter its connection details.",
} as const satisfies Record<ConnectFailure, string>;

/** The line each failure shows under the field. */
export const describeConnectFailure = (failure: ConnectFailure): string => FAILURE_LINES[failure];
