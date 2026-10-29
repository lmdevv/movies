import { assert, describe, it } from "@effect/vitest";
import { Context, Deferred, Duration, Effect, Layer, Predicate, Redacted, Schedule } from "effect";

import { EpochMillis } from "@movies/contracts/units";
import * as FakeConvex from "@movies/sdk/testing/fake-convex";
import { jwtIssuedAt, Reply } from "@movies/sdk/testing/fake-convex";

import * as MediaBackend from "./media-backend.ts";

const ENDED_SESSIONS = "mediaService:endedSessions";

/** The session Convex Auth names in every token for the service's key: `userId|sessionId`. */
const KEY_SESSION = "service|key-session";

/** Tokens for the key's session, signed now; a later second gives a different token. */
const keySession = (refreshToken: string) =>
  Reply.Success({
    value: { tokens: { token: jwtIssuedAt(Date.now(), 3600, KEY_SESSION), refreshToken } },
  });

const isRefresh = (request: FakeConvex.RecordedRequest) =>
  Predicate.hasProperty(request.args, "refreshToken");

/**
 * A Convex deployment that, as the real one does, signs every sign-in with one API key into that
 * key's one session, and lists no ended sessions.
 */
const makeConvex = Effect.gen(function* () {
  const fake = yield* FakeConvex.make;
  let refreshTokens = 0;

  yield* fake.handle("auth:signIn", () =>
    Effect.sync(() => {
      refreshTokens += 1;

      return keySession(`refresh-${String(refreshTokens)}`);
    }),
  );
  yield* fake.reply("auth:signOut", Reply.Success({ value: null }));
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

  it.live(
    "keeps the session it signed in again to when an earlier refresh lands late",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeConvex;
        const refreshing = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let refreshes = 0;

        yield* fake.handle("auth:signIn", (request) =>
          Effect.gen(function* () {
            if (!isRefresh(request)) return keySession("signed-in");
            refreshes += 1;

            if (refreshes === 1) {
              yield* Deferred.succeed(refreshing, undefined);
              yield* Deferred.await(release);
            }

            return keySession(`refreshed-${String(refreshes)}`);
          }),
        );

        const backend = yield* connect(fake);

        yield* Deferred.await(refreshing).pipe(Effect.timeout(Duration.seconds(10)));
        yield* awaitStatus(backend, "connected");
        // A new second, so signing in again mints a token the fake has not refused.
        yield* Effect.sleep(Duration.millis(1100));
        yield* fake.refuseAcceptedTokens;

        yield* fake.requestsTo("auth:signIn").pipe(
          Effect.repeat({
            until: (requests) => requests.filter((r) => !isRefresh(r)).length >= 2,
            schedule: Schedule.spaced("100 millis"),
          }),
          Effect.timeout(Duration.seconds(10)),
        );
        yield* Deferred.succeed(release, undefined);

        const recovered = yield* endedSessions(backend).pipe(
          Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 20 }),
        );

        assert.deepStrictEqual(recovered, []);
        assert.deepStrictEqual(yield* fake.requestsTo("auth:signOut"), []);
      }),
    40_000,
  );
});
