import { createHmac } from "node:crypto";

import { assert, describe, it } from "@effect/vitest";
import { Effect, Redacted } from "effect";
import { TestClock } from "effect/testing";

import * as PlaybackToken from "./playback-token.ts";

// A fixed 32-byte secret, base64url encoded the way `PLAYBACK_TOKEN_SECRET` is configured.
const secretBytes = Buffer.from(
  "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  "hex",
);

const secret = Redacted.make(secretBytes.toString("base64url"));

const claims = {
  aud: "media",
  sub: "user_1",
  pid: "profile_1",
  fid: "file_1",
  sid: "session_1",
  iat: 1_000,
  exp: 21_601_000,
};

/** Signs a token independently of the module under test, with Node's HMAC. */
const sign = (payload: string, key: Buffer = secretBytes): string => {
  const encoded = Buffer.from(payload, "utf8").toString("base64url");
  const signature = createHmac("sha256", key).update(`v1.${encoded}`).digest("base64url");

  return `v1.${encoded}.${signature}`;
};

const verify = (token: string) =>
  Effect.gen(function* () {
    const verifier = yield* PlaybackToken.make(secret).pipe(Effect.orDie);

    return yield* verifier.verify(Redacted.make(token));
  });

const rejection = (token: string) =>
  verify(token).pipe(
    Effect.flip,
    Effect.map((error) => error.reason),
  );

describe("PlaybackToken", () => {
  it.effect("accepts a token signed with the shared secret before it expires", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(5_000);
      const grant = yield* verify(sign(JSON.stringify(claims)));

      assert.deepStrictEqual(grant, {
        userId: "user_1",
        profileId: "profile_1",
        fileId: "file_1",
        sessionId: "session_1",
        expiresAt: 21_601_000,
      });
    }),
  );

  it.effect("matches a fixed test vector", () =>
    Effect.gen(function* () {
      // Computed once with node:crypto; it pins the wire format, not just a round trip.
      const token =
        "v1.eyJhdWQiOiJtZWRpYSIsInN1YiI6InVzZXJfMSIsInBpZCI6InByb2ZpbGVfMSIsImZpZCI6ImZpbGVfMSIsInNpZCI6InNlc3Npb25fMSIsImlhdCI6MTAwMCwiZXhwIjoyMTYwMTAwMH0." +
        sign(JSON.stringify(claims)).split(".")[2];

      assert.strictEqual(token, sign(JSON.stringify(claims)));
      yield* TestClock.setTime(5_000);
      const grant = yield* verify(token);

      assert.strictEqual(grant.fileId, "file_1");
    }),
  );

  it.effect("rejects a token at or after its expiry", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(claims.exp);

      assert.strictEqual(yield* rejection(sign(JSON.stringify(claims))), "expired");
    }),
  );

  it.effect("rejects another audience", () =>
    Effect.gen(function* () {
      const token = sign(JSON.stringify({ ...claims, aud: "convex" }));

      assert.strictEqual(yield* rejection(token), "wrong-audience");
    }),
  );

  it.effect("rejects a signature made with another key", () =>
    Effect.gen(function* () {
      const token = sign(JSON.stringify(claims), Buffer.alloc(32, 7));

      assert.strictEqual(yield* rejection(token), "bad-signature");
    }),
  );

  it.effect("rejects a payload altered after signing", () =>
    Effect.gen(function* () {
      const [version, , signature] = sign(JSON.stringify(claims)).split(".");

      const forged = Buffer.from(JSON.stringify({ ...claims, fid: "file_2" })).toString(
        "base64url",
      );

      assert.strictEqual(yield* rejection(`${version}.${forged}.${signature}`), "bad-signature");
    }),
  );

  it.effect("rejects malformed tokens", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* rejection("v2.a.b"), "malformed");
      assert.strictEqual(yield* rejection("v1.only-two"), "malformed");
      assert.strictEqual(yield* rejection("v1.a+b.c"), "malformed");
      assert.strictEqual(yield* rejection(sign("not json")), "malformed");
      assert.strictEqual(yield* rejection(sign(JSON.stringify({ aud: "media" }))), "malformed");
    }),
  );

  it.effect("refuses a secret shorter than 32 bytes", () =>
    Effect.gen(function* () {
      const error = yield* PlaybackToken.make(
        Redacted.make(Buffer.alloc(16).toString("base64url")),
      ).pipe(Effect.flip);

      assert.strictEqual(error.decodedBytes, 16);
    }),
  );
});
