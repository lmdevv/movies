import { assert, describe, it } from "@effect/vitest";
import { Context, Deferred, Duration, Effect, Layer, Redacted, Schedule } from "effect";

import { EpochMillis } from "@movies/contracts/units";
import * as FakeConvex from "@movies/sdk/testing/fake-convex";
import { jwtIssuedAt, Reply } from "@movies/sdk/testing/fake-convex";

import * as MediaBackend from "./media-backend.ts";

const ENDED_SESSIONS = "mediaService:endedSessions";

/** A Convex deployment that signs in with a new session each time and lists no ended sessions. */
const makeConvex = Effect.gen(function* () {
  const fake = yield* FakeConvex.make;
  let sessions = 0;

  yield* fake.handle("auth:signIn", () =>
    Effect.sync(() => {
      sessions += 1;

      return Reply.Success({
        value: {
          tokens: {
            token: jwtIssuedAt(Date.now(), 3600, `service|session-${String(sessions)}`),
            refreshToken: `refresh-${String(sessions)}`,
          },
        },
      });
    }),
  );
  yield* fake.reply(ENDED_SESSIONS, Reply.Success({ value: [] }));

  return fake;
});

const connect = (fake: FakeConvex.FakeConvex) =>
  Layer.build(
    MediaBackend.layer({
      convexUrl: fake.url,
      apiKey: Redacted.make("mk_service"),
      callTimeout: Duration.seconds(2),
      probeEvery: Duration.seconds(1),
    }),
  ).pipe(Effect.map((context) => Context.get(context, MediaBackend.Service)));

const awaitStatus = (backend: MediaBackend.Interface, status: "connected" | "connecting") =>
  backend.status.pipe(
    Effect.repeat({
      until: (current) => current === status,
      schedule: Schedule.spaced("100 millis"),
    }),
    Effect.timeout(Duration.seconds(10)),
  );

const endedSessions = (backend: MediaBackend.Interface) =>
  backend.call("mediaService.endedSessions", { after: EpochMillis.make(Date.now()) });

describe("media service Convex connection", () => {
  it.live(
    "signs in again when Convex stops taking its token without saying so",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeConvex;
        const backend = yield* connect(fake);

        yield* awaitStatus(backend, "connected");
        const refused = new Set(yield* fake.acceptedTokens);

        // The Convex client reconnects presenting the refused token, and is never told why.
        yield* fake.refuseAcceptedTokens;

        const recovered = yield* endedSessions(backend).pipe(
          Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 20 }),
        );

        assert.deepStrictEqual(recovered, []);
        assert.isTrue((yield* fake.acceptedTokens).some((token) => !refused.has(token)));
        yield* awaitStatus(backend, "connected");
      }),
    40_000,
  );

  it.live(
    "stays connected while idle, and reports connecting while Convex does not answer",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeConvex;
        const backend = yield* connect(fake);

        yield* awaitStatus(backend, "connected");

        // Idle for longer than an answer stays fresh: the probes keep it fresh.
        yield* Effect.sleep(Duration.seconds(4));
        assert.strictEqual(yield* backend.status, "connected");

        const answering = yield* Deferred.make<void>();

        yield* fake.handle(ENDED_SESSIONS, () =>
          Deferred.await(answering).pipe(Effect.as(Reply.Success({ value: [] }))),
        );

        yield* awaitStatus(backend, "connecting");

        yield* fake.reply(ENDED_SESSIONS, Reply.Success({ value: [] }));
        yield* Deferred.succeed(answering, undefined);

        yield* awaitStatus(backend, "connected");
      }),
    40_000,
  );
});
