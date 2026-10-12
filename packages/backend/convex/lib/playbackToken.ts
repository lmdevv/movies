/**
 * Signs playback tokens in the Convex runtime with WebCrypto, in the format docs/decisions.md and
 * `@movies/contracts/playback-token` define: `v1.<base64url JSON>.<base64url HMAC-SHA256>`.
 * The backend tests check this signer against the shared test vectors and the contracts verifier.
 */
import { base64UrlDecode, base64UrlEncode } from "./crypto";
import { fail } from "./errors";

/** How long a playback token stays valid; equals `PLAYBACK_TOKEN_LIFETIME_MS` in contracts. */
export const PLAYBACK_TOKEN_LIFETIME_MS = 6 * 60 * 60 * 1000;

const MIN_SECRET_BYTES = 32;

const encoder = new TextEncoder();

/**
 * The claims a token carries: user, profile, file, and playback session IDs and the issue and
 * expiry instants. Key order is part of the signed bytes.
 */
export interface PlaybackClaims {
  readonly sub: string;
  readonly pid: string;
  readonly fid: string;
  readonly sid: string;
  readonly iat: number;
  readonly exp: number;
}

/** Signs claims with a base64url secret of at least 32 bytes. */
export const signPlaybackToken = async (
  secret: string,
  claims: PlaybackClaims,
): Promise<string> => {
  const keyBytes = base64UrlDecode(secret);

  if (keyBytes === null || keyBytes.length < MIN_SECRET_BYTES) {
    return fail("internal", "PLAYBACK_TOKEN_SECRET must be base64url of at least 32 bytes");
  }

  const payload = JSON.stringify({
    aud: "media",
    sub: claims.sub,
    pid: claims.pid,
    fid: claims.fid,
    sid: claims.sid,
    iat: claims.iat,
    exp: claims.exp,
  });

  const signed = `v1.${base64UrlEncode(encoder.encode(payload))}`;

  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(signed));

  return `${signed}.${base64UrlEncode(new Uint8Array(signature))}`;
};

/** Reads `PLAYBACK_TOKEN_SECRET`, failing with `internal` when the deployment lacks it. */
export const playbackTokenSecret = (): string => {
  const secret = process.env.PLAYBACK_TOKEN_SECRET;

  if (secret === undefined || secret.length === 0) {
    return fail("internal", "PLAYBACK_TOKEN_SECRET is not set on this deployment");
  }

  return secret;
};

/** The client-reachable media service URL, from `MEDIA_BASE_URL`. */
export const mediaBaseUrl = (): string => {
  const url = process.env.MEDIA_BASE_URL;

  if (url === undefined || url.length === 0) {
    return fail("internal", "MEDIA_BASE_URL is not set on this deployment");
  }

  return url;
};
