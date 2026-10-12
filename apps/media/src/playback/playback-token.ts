/**
 * Verifies the HMAC-signed playback tokens Convex issues (format in `docs/decisions.md`):
 * `v1.<payload>.<signature>`, where `payload` is base64url JSON and `signature` is base64url
 * HMAC-SHA256 over `v1.<payload>` keyed with the decoded `PLAYBACK_TOKEN_SECRET`.
 *
 * The signature is checked in constant time before the payload is parsed, so unauthenticated
 * bytes never reach the JSON decoder. Tokens are `Redacted` from the HTTP boundary to here and
 * never appear in errors or logs.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import { Clock, Context, Effect, Layer, Redacted, Schema } from "effect";

import { FileId, PlaybackSessionId, ProfileId, UserId } from "../ids.ts";
import * as MediaConfig from "../media-config.ts";

/** What a verified token allows: one profile playing one file in one playback session. */
export interface PlaybackGrant {
  readonly userId: UserId;
  readonly profileId: ProfileId;
  readonly fileId: FileId;
  readonly sessionId: PlaybackSessionId;
  /** Expiry in milliseconds since the epoch. */
  readonly expiresAt: number;
}

/** Why a playback token was rejected. */
type InvalidTokenReason = "malformed" | "bad-signature" | "wrong-audience" | "expired";

/** A playback token was missing, forged, expired, or meant for another service. */
export class InvalidPlaybackToken extends Schema.TaggedError<InvalidPlaybackToken>()(
  "InvalidPlaybackToken",
  { reason: Schema.Literals(["malformed", "bad-signature", "wrong-audience", "expired"]) },
  { httpApiStatus: 401 },
) {
  override get message(): string {
    return `Playback token rejected: ${this.reason}`;
  }
}

/** `PLAYBACK_TOKEN_SECRET` is not base64url of at least 32 bytes. */
export class PlaybackTokenSecretInvalid extends Schema.TaggedError<PlaybackTokenSecretInvalid>()(
  "PlaybackTokenSecretInvalid",
  { decodedBytes: Schema.Int },
) {
  override get message(): string {
    return `Playback token secret invalid: expected base64url of at least 32 bytes, got ${this.decodedBytes}`;
  }
}

/** Checks playback tokens. */
export interface Interface {
  readonly verify: (token: Redacted.Redacted) => Effect.Effect<PlaybackGrant, InvalidPlaybackToken>;
}

/** The playback token verifier. */
export class Service extends Context.Service<Service, Interface>()(
  "@movies/media/PlaybackTokenVerifier",
) {}

const MIN_SECRET_BYTES = 32;

const BASE64URL = /^[A-Za-z0-9_-]+$/;

const Claims = Schema.Struct({
  aud: Schema.String,
  sub: UserId,
  pid: ProfileId,
  fid: FileId,
  sid: PlaybackSessionId,
  iat: Schema.Finite,
  exp: Schema.Finite,
});

const decodeClaims = Schema.decodeUnknownEffect(Schema.fromJsonString(Claims));

const reject = (reason: InvalidTokenReason): InvalidPlaybackToken =>
  new InvalidPlaybackToken({ reason });

const decodeSecret = (
  secret: Redacted.Redacted,
): Effect.Effect<Buffer, PlaybackTokenSecretInvalid> => {
  const text = Redacted.value(secret).trim();
  const key = BASE64URL.test(text) ? Buffer.from(text, "base64url") : Buffer.alloc(0);

  return key.length >= MIN_SECRET_BYTES
    ? Effect.succeed(key)
    : Effect.fail(new PlaybackTokenSecretInvalid({ decodedBytes: key.length }));
};

/** Builds a verifier for tokens signed with `secret`. */
export const make = Effect.fn("PlaybackTokenVerifier.make")(function* (secret: Redacted.Redacted) {
  const key = yield* decodeSecret(secret);

  const verify = Effect.fn("PlaybackTokenVerifier.verify")(function* (token: Redacted.Redacted) {
    const parts = Redacted.value(token).split(".");

    if (parts.length !== 3 || parts[0] !== "v1") return yield* reject("malformed");
    const [, payload = "", signature = ""] = parts;

    if (!BASE64URL.test(payload) || !BASE64URL.test(signature)) {
      return yield* reject("malformed");
    }

    const expected = createHmac("sha256", key).update(`v1.${payload}`, "ascii").digest();
    const given = Buffer.from(signature, "base64url");

    // Only the canonical encoding counts; base64url padding bits must not create aliases.
    if (given.toString("base64url") !== signature) return yield* reject("malformed");

    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return yield* reject("bad-signature");
    }

    const claims = yield* decodeClaims(Buffer.from(payload, "base64url").toString("utf8")).pipe(
      Effect.mapError(() => reject("malformed")),
    );

    if (claims.aud !== "media") return yield* reject("wrong-audience");

    if (claims.exp <= (yield* Clock.currentTimeMillis)) return yield* reject("expired");

    return {
      userId: claims.sub,
      profileId: claims.pid,
      fileId: claims.fid,
      sessionId: claims.sid,
      expiresAt: claims.exp,
    } satisfies PlaybackGrant;
  });

  return Service.of({ verify });
});

/** Verifies tokens with `PLAYBACK_TOKEN_SECRET` from the media configuration. */
export const layer: Layer.Layer<Service, PlaybackTokenSecretInvalid, MediaConfig.Service> =
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const config = yield* MediaConfig.Service;

      return yield* make(config.playbackTokenSecret);
    }),
  );
