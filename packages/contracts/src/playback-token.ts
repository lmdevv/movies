/**
 * Playback tokens: `v1.<payload>.<signature>`. `payload` is base64url (no padding) of UTF-8 JSON;
 * `signature` is base64url HMAC-SHA256 over the ASCII string `v1.<payload>`, keyed with the raw
 * bytes of `PLAYBACK_TOKEN_SECRET` (a base64url string of at least 32 random bytes).
 *
 * Convex signs with WebCrypto in plain TypeScript; the media service verifies with this module.
 * Both test against `PLAYBACK_TOKEN_TEST_VECTORS`.
 */
import { Clock, Effect, Redacted, Result, Schema } from "effect";
import { Base64Url } from "effect/encoding";

import { MediaFileId, PlaybackSessionId, ProfileId, UserId } from "./ids";
import { EpochMillis } from "./units";

/** The token format version, which is also the first segment of every token. */
export const PLAYBACK_TOKEN_VERSION = "v1";

/** The audience every playback token names. */
export const PLAYBACK_TOKEN_AUDIENCE = "media";

/** How long a playback token stays valid. */
export const PLAYBACK_TOKEN_LIFETIME_MS = 6 * 60 * 60 * 1000;

/** The smallest accepted secret, in bytes. */
export const PLAYBACK_TOKEN_SECRET_MIN_BYTES = 32;

/** What a valid playback token authorizes: one user's profile playing one file in one session. */
export const PlaybackTokenPayload = Schema.Struct({
  aud: Schema.Literal(PLAYBACK_TOKEN_AUDIENCE),
  sub: UserId,
  pid: ProfileId,
  fid: MediaFileId,
  sid: PlaybackSessionId,
  iat: EpochMillis,
  exp: EpochMillis,
});

/** What a valid playback token authorizes. */
export interface PlaybackTokenPayload extends Schema.Schema.Type<typeof PlaybackTokenPayload> {}

/** The claims as signed, before the audience is checked. */
const SignedClaims = Schema.fromJsonString(
  Schema.Struct({
    ...PlaybackTokenPayload.fields,
    aud: Schema.String,
  }),
);

const decodeSignedClaims = Schema.decodeUnknownEffect(SignedClaims);

/**
 * Why a playback token was rejected. Never includes the token itself. The media service answers
 * it with status 401; an `expired` token is renewed with `playback.renewToken`.
 */
export class PlaybackTokenInvalid extends Schema.TaggedError<PlaybackTokenInvalid>()(
  "PlaybackTokenInvalid",
  {
    reason: Schema.Literals(["malformed", "bad_signature", "wrong_audience", "expired"]),
    message: Schema.String,
  },
  { httpApiStatus: 401 },
) {}

/** `PLAYBACK_TOKEN_SECRET` is not base64url or is shorter than 32 bytes. Never includes the secret. */
export class PlaybackTokenSecretInvalid extends Schema.TaggedError<PlaybackTokenSecretInvalid>()(
  "PlaybackTokenSecretInvalid",
  { message: Schema.String },
) {}

/** An imported HMAC key, ready to sign and verify. Build it once with `importPlaybackTokenSecret`. */
export interface PlaybackTokenKey {
  readonly hmac: CryptoKey;
}

const encoder = new TextEncoder();

/**
 * Imports `PLAYBACK_TOKEN_SECRET` for signing and verification.
 *
 * @returns The key, or `PlaybackTokenSecretInvalid` when the secret is not base64url of at least
 * 32 bytes.
 */
export const importPlaybackTokenSecret = Effect.fn("importPlaybackTokenSecret")(function* (
  secret: Redacted.Redacted,
): Effect.fn.Return<PlaybackTokenKey, PlaybackTokenSecretInvalid> {
  const decoded = Base64Url.decode(Redacted.value(secret));

  if (Result.isFailure(decoded)) {
    return yield* new PlaybackTokenSecretInvalid({
      message: "Playback token secret is not base64url",
    });
  }

  if (decoded.success.length < PLAYBACK_TOKEN_SECRET_MIN_BYTES) {
    return yield* new PlaybackTokenSecretInvalid({
      message: `Playback token secret must decode to at least ${PLAYBACK_TOKEN_SECRET_MIN_BYTES} bytes`,
    });
  }

  // WebCrypto rejects only for unsupported algorithms or key data it cannot use, which a decoded
  // byte string never is; a rejection here is a defect.
  const hmac = yield* Effect.promise(() =>
    crypto.subtle.importKey(
      "raw",
      Uint8Array.from(decoded.success),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    ),
  );

  return { hmac };
});

const hmacSha256 = (key: PlaybackTokenKey, message: string): Effect.Effect<Uint8Array> =>
  // HMAC signing with an imported HMAC key cannot fail for valid input; a rejection is a defect.
  Effect.map(
    Effect.promise(() => crypto.subtle.sign("HMAC", key.hmac, encoder.encode(message))),
    (signature) => new Uint8Array(signature),
  );

/** Compares two byte strings in time that depends only on their lengths. */
const constantTimeEqual = (left: Uint8Array, right: Uint8Array): boolean => {
  let difference = left.length ^ right.length;

  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }

  return difference === 0;
};

const BASE64URL_SEGMENT = /^[\w-]+$/u;

const invalid = (reason: PlaybackTokenInvalid["reason"], message: string) =>
  new PlaybackTokenInvalid({ reason, message });

/**
 * Signs a payload. Convex signs tokens itself; this exists for the media service's tests and for
 * the shared test vectors.
 */
export const signPlaybackToken = Effect.fn("signPlaybackToken")(function* (
  key: PlaybackTokenKey,
  payload: PlaybackTokenPayload,
): Effect.fn.Return<string> {
  const body = Base64Url.encode(JSON.stringify(payload));
  const signed = `${PLAYBACK_TOKEN_VERSION}.${body}`;
  const signature = yield* hmacSha256(key, signed);

  return `${signed}.${Base64Url.encode(signature)}`;
});

/**
 * Verifies a playback token against the current `Clock` time. Checks the signature in constant
 * time before reading the payload, then the audience, then expiry (`exp <= now` is expired).
 *
 * @returns The payload, or `PlaybackTokenInvalid` with the reason it was rejected.
 */
export const verifyPlaybackToken = Effect.fn("verifyPlaybackToken")(function* (
  key: PlaybackTokenKey,
  token: string,
): Effect.fn.Return<PlaybackTokenPayload, PlaybackTokenInvalid> {
  const segments = token.split(".");
  const [version, body, signature] = segments;

  if (
    segments.length !== 3 ||
    version !== PLAYBACK_TOKEN_VERSION ||
    body === undefined ||
    signature === undefined ||
    !BASE64URL_SEGMENT.test(body) ||
    !BASE64URL_SEGMENT.test(signature)
  ) {
    return yield* invalid("malformed", "Playback token is malformed");
  }

  const presented = Base64Url.decode(signature);

  // Only the canonical encoding counts: base64url padding bits must not create aliases.
  if (Result.isFailure(presented) || Base64Url.encode(presented.success) !== signature) {
    return yield* invalid("malformed", "Playback token signature is not canonical base64url");
  }

  const expected = yield* hmacSha256(key, `${version}.${body}`);

  if (!constantTimeEqual(expected, presented.success)) {
    return yield* invalid("bad_signature", "Playback token signature does not match");
  }

  const json = Base64Url.decodeString(body);

  if (Result.isFailure(json)) {
    return yield* invalid("malformed", "Playback token payload is not base64url");
  }

  const claims = yield* decodeSignedClaims(json.success).pipe(
    Effect.mapError(() => invalid("malformed", "Playback token payload has the wrong fields")),
  );

  if (claims.aud !== PLAYBACK_TOKEN_AUDIENCE) {
    return yield* invalid("wrong_audience", "Playback token is for another audience");
  }

  const now = yield* Clock.currentTimeMillis;

  if (claims.exp <= now) return yield* invalid("expired", "Playback token has expired");

  return { ...claims, aud: PLAYBACK_TOKEN_AUDIENCE };
});

/** A token that every verifier must reject, and why. */
export interface RejectedTokenVector {
  readonly description: string;
  readonly token: string;
  readonly verifyAt: number;
  readonly reason: PlaybackTokenInvalid["reason"];
}

const VALID_TOKEN =
  "v1.eyJhdWQiOiJtZWRpYSIsInN1YiI6Imo1NzAxeXFibXJzZzJzMWJqdmh3ajZ4NWE5N3QzcWQ1IiwicGlkIjoiazE3MWF4OWV3cTB0dHQwbTNheHZibW56dzk3dDN4M20iLCJmaWQiOiJrZDdheThyMHR5MXJ5NnE5eTZlcXZkYzN5OTd0MndtZiIsInNpZCI6Imp4NzZrNmdhMzZnN3RmaGY5dnRtMXlhaGJzN3QzY2N2IiwiaWF0IjoxNzYwMDAwMDAwMDAwLCJleHAiOjE3NjAwMjE2MDAwMDB9._3-7r8dV1nu5neIQTKAD9Ytq6xIxm-RTqgak580So74";

/**
 * Fixed inputs and outputs every signer and verifier must reproduce, computed independently with
 * Node's `createHmac`. `secret` is a test value (bytes 0 to 31), never a deployment secret. Signing
 * `valid.payloadJson` (the payload serialized with keys in the order shown) with `secret` yields
 * exactly `valid.token`, which verifies at `valid.verifyAt`; every `rejected` token fails with its
 * `reason`.
 */
export const PLAYBACK_TOKEN_TEST_VECTORS = {
  /** Base64url of the 32 bytes 0, 1, …, 31: `AAECAw…HB0eHw` without padding. */
  secret: Base64Url.encode(Uint8Array.from({ length: 32 }, (_, index) => index)),
  valid: {
    payload: {
      aud: "media",
      sub: "j5701yqbmrsg2s1bjvhwj6x5a97t3qd5",
      pid: "k171ax9ewq0ttt0m3axvbmnzw97t3x3m",
      fid: "kd7ay8r0ty1ry6q9y6eqvdc3y97t2wmf",
      sid: "jx76k6ga36g7tfhf9vtm1yahbs7t3ccv",
      iat: 1_760_000_000_000,
      exp: 1_760_021_600_000,
    },
    payloadJson:
      '{"aud":"media","sub":"j5701yqbmrsg2s1bjvhwj6x5a97t3qd5","pid":"k171ax9ewq0ttt0m3axvbmnzw97t3x3m","fid":"kd7ay8r0ty1ry6q9y6eqvdc3y97t2wmf","sid":"jx76k6ga36g7tfhf9vtm1yahbs7t3ccv","iat":1760000000000,"exp":1760021600000}',
    token: VALID_TOKEN,
    verifyAt: 1_760_000_001_000,
  },
  rejected: [
    {
      description: "valid token at its expiry instant",
      token: VALID_TOKEN,
      verifyAt: 1_760_021_600_000,
      reason: "expired",
    },
    {
      description: "one signature character changed",
      token:
        "v1.eyJhdWQiOiJtZWRpYSIsInN1YiI6Imo1NzAxeXFibXJzZzJzMWJqdmh3ajZ4NWE5N3QzcWQ1IiwicGlkIjoiazE3MWF4OWV3cTB0dHQwbTNheHZibW56dzk3dDN4M20iLCJmaWQiOiJrZDdheThyMHR5MXJ5NnE5eTZlcXZkYzN5OTd0MndtZiIsInNpZCI6Imp4NzZrNmdhMzZnN3RmaGY5dnRtMXlhaGJzN3QzY2N2IiwiaWF0IjoxNzYwMDAwMDAwMDAwLCJleHAiOjE3NjAwMjE2MDAwMDB9._3-7r8dV1nu5neIQTKAD9Ytq6xIxm-RTqgak580SoA4",
      verifyAt: 1_760_000_001_000,
      reason: "bad_signature",
    },
    {
      description: "signed with a different secret (32 bytes of 0x07)",
      token:
        "v1.eyJhdWQiOiJtZWRpYSIsInN1YiI6Imo1NzAxeXFibXJzZzJzMWJqdmh3ajZ4NWE5N3QzcWQ1IiwicGlkIjoiazE3MWF4OWV3cTB0dHQwbTNheHZibW56dzk3dDN4M20iLCJmaWQiOiJrZDdheThyMHR5MXJ5NnE5eTZlcXZkYzN5OTd0MndtZiIsInNpZCI6Imp4NzZrNmdhMzZnN3RmaGY5dnRtMXlhaGJzN3QzY2N2IiwiaWF0IjoxNzYwMDAwMDAwMDAwLCJleHAiOjE3NjAwMjE2MDAwMDB9.F_7UyxfPvGoAha_sde6IRXfG0eS89iZis6SM1d2LUWM",
      verifyAt: 1_760_000_001_000,
      reason: "bad_signature",
    },
    {
      description: "correctly signed with audience web",
      token:
        "v1.eyJhdWQiOiJ3ZWIiLCJzdWIiOiJqNTcwMXlxYm1yc2cyczFianZod2o2eDVhOTd0M3FkNSIsInBpZCI6ImsxNzFheDlld3EwdHR0MG0zYXh2Ym1uenc5N3QzeDNtIiwiZmlkIjoia2Q3YXk4cjB0eTFyeTZxOXk2ZXF2ZGMzeTk3dDJ3bWYiLCJzaWQiOiJqeDc2azZnYTM2Zzd0ZmhmOXZ0bTF5YWhiczd0M2NjdiIsImlhdCI6MTc2MDAwMDAwMDAwMCwiZXhwIjoxNzYwMDIxNjAwMDAwfQ.5yl0qeSwTb9I4xFENOrOH6xNVT9egoFRw5u4v8uYtRA",
      verifyAt: 1_760_000_001_000,
      reason: "wrong_audience",
    },
    {
      description: "unknown version",
      token: "v2.e30.AAAA",
      verifyAt: 1_760_000_001_000,
      reason: "malformed",
    },
    {
      description: "missing signature segment",
      token: "v1.e30",
      verifyAt: 1_760_000_001_000,
      reason: "malformed",
    },
  ] satisfies ReadonlyArray<RejectedTokenVector>,
} as const;
