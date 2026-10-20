import { Effect, Exit, ManagedRuntime, Redacted, Schema } from "effect";
import { TestClock } from "effect/testing";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  importPlaybackTokenSecret,
  PLAYBACK_TOKEN_LIFETIME_MS,
  PLAYBACK_TOKEN_TEST_VECTORS,
  PlaybackTokenInvalid,
  PlaybackTokenPayload,
  PlaybackTokenSecretInvalid,
  signPlaybackToken,
  verifyPlaybackToken,
} from "./playback-token";

const vectors = PLAYBACK_TOKEN_TEST_VECTORS;

const decodePayload = Schema.decodeUnknownSync(PlaybackTokenPayload);

const vectorKey = Effect.orDie(importPlaybackTokenSecret(Redacted.make(vectors.secret)));

const runtime = ManagedRuntime.make(TestClock.layer());

const run = <A, E>(program: Effect.Effect<A, E, TestClock.TestClock>): Promise<A> =>
  runtime.runPromise(program);

const verifyAt = (token: string, now: number) =>
  Effect.gen(function* () {
    const key = yield* vectorKey;
    yield* TestClock.setTime(now);

    return yield* verifyPlaybackToken(key, token);
  });

const documentId = fc.stringMatching(/^[a-z0-9]{32}$/u);

const payloads = fc
  .record({
    sub: documentId,
    pid: documentId,
    fid: documentId,
    sid: documentId,
    iat: fc.integer({ min: 0, max: 4_000_000_000_000 }),
  })
  .map((claims) =>
    decodePayload({ ...claims, aud: "media", exp: claims.iat + PLAYBACK_TOKEN_LIFETIME_MS }),
  );

describe("playback tokens", () => {
  it("signs the valid vector exactly", async () => {
    const token = await run(
      Effect.flatMap(vectorKey, (key) =>
        signPlaybackToken(key, decodePayload(vectors.valid.payload)),
      ),
    );

    expect(token).toBe(vectors.valid.token);
    expect(JSON.stringify(vectors.valid.payload)).toBe(vectors.valid.payloadJson);
  });

  it("verifies the valid vector before it expires", async () => {
    const payload = await run(verifyAt(vectors.valid.token, vectors.valid.verifyAt));

    expect(payload).toStrictEqual(decodePayload(vectors.valid.payload));
  });

  it("signs and verifies the download vector with its purpose", async () => {
    const payload = decodePayload(vectors.download.payload);
    const token = await run(Effect.flatMap(vectorKey, (key) => signPlaybackToken(key, payload)));

    expect(token).toBe(vectors.download.token);
    expect(JSON.stringify(vectors.download.payload)).toBe(vectors.download.payloadJson);
    await expect(run(verifyAt(token, vectors.download.verifyAt))).resolves.toStrictEqual(payload);
  });

  it.each(vectors.rejected)("rejects $description", async (vector) => {
    const error = await run(Effect.flip(verifyAt(vector.token, vector.verifyAt)));

    expect(error).toBeInstanceOf(PlaybackTokenInvalid);
    expect(error.reason).toBe(vector.reason);
    expect(JSON.stringify(error)).not.toContain(vector.token);
  });

  it("round-trips any payload until the instant it expires", async () => {
    await fc.assert(
      fc.asyncProperty(payloads, async (payload) => {
        const [before, at] = await run(
          Effect.gen(function* () {
            const key = yield* vectorKey;
            const token = yield* signPlaybackToken(key, payload);

            return [
              yield* Effect.exit(verifyAt(token, payload.exp - 1)),
              yield* Effect.exit(verifyAt(token, payload.exp)),
            ] as const;
          }),
        );

        expect(before).toStrictEqual(Exit.succeed(payload));
        expect(Exit.isFailure(at)).toBe(true);
      }),
    );
  });

  it("rejects a secret shorter than 32 bytes without echoing it", async () => {
    const short = "c2hvcnQtc2VjcmV0";
    const error = await run(Effect.flip(importPlaybackTokenSecret(Redacted.make(short))));

    expect(error).toBeInstanceOf(PlaybackTokenSecretInvalid);
    expect(JSON.stringify(error)).not.toContain(short);
  });

  it("lasts six hours", () => {
    expect(PLAYBACK_TOKEN_LIFETIME_MS).toBe(6 * 60 * 60 * 1000);
    expect(vectors.valid.payload.exp - vectors.valid.payload.iat).toBe(PLAYBACK_TOKEN_LIFETIME_MS);
  });
});
