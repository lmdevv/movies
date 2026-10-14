import { inspect } from "node:util";

import {
  Context,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Logger,
  Option,
  Predicate,
  Redacted,
  Ref,
} from "effect";
import type { Scope } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import * as Auth from "./auth";
import * as Movies from "./movies";
import { MoviesClient } from "./movies-client";
import * as FakeConvex from "./testing/fake-convex";
import { jwtExpiringAt, Reply } from "./testing/fake-convex";
import * as TokenStorage from "./token-storage";
import type { KeyValueStore } from "./token-storage";

const START = 1_760_000_000_000;

const KEY = "movies.session";

/** A token that stays valid well past every test. */
const FRESH = jwtExpiringAt(START + 3_600_000, "alex");

/** A token inside the renewal margin. */
const EXPIRING = jwtExpiringAt(START + 30_000, "alex");

/** A token that expired ten minutes ago. */
const EXPIRED = jwtExpiringAt(START - 600_000, "alex");

/** The token the refresh hands out, and the refresh token it rotates to. */
const RENEWED = jwtExpiringAt(START + 3_600_000, "alex-renewed");

const ROTATED = "refresh-2";

/** A token store in memory whose writes can be made to fail. */
interface MemoryStore {
  readonly store: KeyValueStore;
  /** The session the store holds now, as plain tokens. */
  readonly saved: () => Option.Option<{ readonly token: string; readonly refreshToken: string }>;
  readonly failWrites: (failing: boolean) => void;
  readonly failClears: (failing: boolean) => void;
}

const memoryStore = (initial: Option.Option<{ token: string; refreshToken: string }>) => {
  const items = new Map<string, string>();
  let failing = false;
  let failingClears = false;

  if (Option.isSome(initial)) {
    items.set(
      KEY,
      TokenStorage.serializeSession({
        token: Redacted.make(initial.value.token),
        refreshToken: Redacted.make(initial.value.refreshToken),
      }),
    );
  }

  const memory: MemoryStore = {
    store: {
      getItem: (key) => items.get(key) ?? null,
      setItem: (key, value) => {
        if (failing) throw new Error(`The disk is full; could not write ${value}`);
        items.set(key, value);
      },
      removeItem: (key) => {
        if (failingClears) throw new Error("The disk is read-only");
        items.delete(key);
      },
    },
    saved: () =>
      Option.map(
        Option.flatMap(Option.fromNullishOr(items.get(KEY)), TokenStorage.parseStoredSession),
        (session) => ({
          token: Redacted.value(session.token),
          refreshToken: Redacted.value(session.refreshToken),
        }),
      ),
    failWrites: (next) => {
      failing = next;
    },
    failClears: (next) => {
      failingClears = next;
    },
  };

  return memory;
};

interface Fixture {
  readonly fake: FakeConvex.FakeConvex;
  readonly memory: MemoryStore;
  readonly auth: Auth.Interface;
  /** Everything logged so far, each entry rendered in full, causes included. */
  readonly logs: () => ReadonlyArray<string>;
}

/**
 * Runs `body` on the test clock with the SDK over HTTP to a fake deployment, starting from the
 * stored session `stored` (signed out when none).
 */
const withAuth = <A, E>(
  stored: Option.Option<{ token: string; refreshToken: string }>,
  body: (fixture: Fixture) => Effect.Effect<A, E, Movies.Services | Scope.Scope>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const logged: Array<string> = [];

        const capture = Logger.make((entry) => {
          logged.push(inspect([entry.message, entry.cause], { depth: 20 }));
        });

        const testClock = yield* Layer.build(
          Layer.mergeAll(TestClock.layer(), Logger.layer([capture])),
        );

        return yield* Effect.gen(function* () {
          yield* TestClock.setTime(START);
          const fake = yield* FakeConvex.make;
          const memory = memoryStore(stored);

          const sdk = yield* Layer.build(
            Movies.layer({ convexUrl: fake.url, mediaUrl: Option.none(), connection: "http" }).pipe(
              Layer.provide(TokenStorage.layerKeyValue(memory.store, KEY)),
            ),
          );

          const auth = Context.get(sdk, Auth.Auth);

          return yield* body({ fake, memory, auth, logs: () => [...logged] }).pipe(
            Effect.provideContext(sdk),
          );
        }).pipe(Effect.provideContext(testClock));
      }),
    ),
  );

const signedInWith = (token: string) => Option.some({ token, refreshToken: "refresh-1" });

const tokens = (token: string, refreshToken: string): Reply =>
  Reply.Success({ value: { tokens: { token, refreshToken } } });

const reveal = (token: Option.Option<Redacted.Redacted>): string | null =>
  Option.match(token, { onNone: () => null, onSome: Redacted.value });

/** The refresh tokens each refresh request sent, in order. */
const refreshRequests = (fake: FakeConvex.FakeConvex) =>
  Effect.map(fake.requestsTo("auth:signIn"), (requests) =>
    requests.flatMap((request) =>
      Predicate.hasProperty(request.args, "refreshToken") ? [request.args.refreshToken] : [],
    ),
  );

/** Holds every refresh until `release`, signalling `arrived` when the first one reaches the server. */
const gateRefresh = (fake: FakeConvex.FakeConvex, reply: Reply) =>
  Effect.gen(function* () {
    const arrived = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();

    yield* fake.handle("auth:signIn", (request) =>
      Predicate.hasProperty(request.args, "refreshToken")
        ? Effect.gen(function* () {
            yield* Deferred.succeed(arrived, undefined);
            yield* Deferred.await(release);

            return reply;
          })
        : Effect.succeed(tokens(jwtExpiringAt(START + 3_600_000, "sam"), "sam-refresh")),
    );

    return { arrived, release };
  });

describe("Auth", () => {
  it("uses a fresh token without refreshing it", () =>
    withAuth(signedInWith(FRESH), ({ fake, auth }) =>
      Effect.gen(function* () {
        expect(yield* auth.currentStatus).toBe("signedIn");
        expect(reveal(yield* auth.accessToken(false))).toBe(FRESH);
        expect(yield* fake.requests).toStrictEqual([]);
      }),
    ));

  it("refreshes a token about to expire once and stores the renewed session", () =>
    withAuth(signedInWith(EXPIRING), ({ fake, memory, auth }) =>
      Effect.gen(function* () {
        yield* fake.reply("auth:signIn", tokens(RENEWED, ROTATED));

        expect(reveal(yield* auth.accessToken(false))).toBe(RENEWED);
        expect(reveal(yield* auth.accessToken(false))).toBe(RENEWED);
        expect(yield* refreshRequests(fake)).toStrictEqual(["refresh-1"]);
        expect(memory.saved()).toStrictEqual(
          Option.some({ token: RENEWED, refreshToken: ROTATED }),
        );
      }),
    ));

  it("shares one refresh between concurrent callers", () =>
    withAuth(signedInWith(FRESH), ({ fake, auth }) =>
      Effect.gen(function* () {
        const gate = yield* gateRefresh(fake, tokens(RENEWED, ROTATED));

        const callers = yield* Effect.forkChild(
          Effect.all([auth.accessToken(true), auth.accessToken(true), auth.accessToken(true)], {
            concurrency: "unbounded",
          }),
        );

        yield* Deferred.await(gate.arrived);
        yield* Deferred.succeed(gate.release, undefined);

        expect((yield* Fiber.join(callers)).map(reveal)).toStrictEqual([RENEWED, RENEWED, RENEWED]);
        expect(yield* refreshRequests(fake)).toStrictEqual(["refresh-1"]);
      }),
    ));

  it("signs out when the server refuses the refresh token", () =>
    withAuth(signedInWith(EXPIRING), ({ fake, memory, auth }) =>
      Effect.gen(function* () {
        yield* fake.reply("auth:signIn", Reply.Success({ value: { tokens: null } }));

        expect(yield* auth.accessToken(false)).toStrictEqual(Option.none());
        expect(yield* auth.currentStatus).toBe("signedOut");
        expect(memory.saved()).toStrictEqual(Option.none());
      }),
    ));

  it("keeps the current token when the server cannot be reached", () =>
    withAuth(signedInWith(EXPIRING), ({ fake, memory, auth }) =>
      Effect.gen(function* () {
        yield* fake.reply("auth:signIn", Reply.Drop());

        expect(reveal(yield* auth.accessToken(false))).toBe(EXPIRING);
        expect(yield* auth.currentStatus).toBe("signedIn");
        expect(memory.saved()).toStrictEqual(signedInWith(EXPIRING));
      }),
    ));

  it("keeps the current token when a refresh gets no answer in time", () =>
    withAuth(signedInWith(EXPIRING), ({ fake, auth }) =>
      Effect.gen(function* () {
        const gate = yield* gateRefresh(fake, tokens(RENEWED, ROTATED));
        const waiting = yield* Effect.forkChild(auth.accessToken(false));

        yield* Deferred.await(gate.arrived);
        yield* TestClock.adjust(60_000);

        expect(reveal(yield* Fiber.join(waiting))).toBe(EXPIRING);
      }),
    ));

  it("does not bring the session back when a refresh lands after sign-out", () =>
    withAuth(signedInWith(FRESH), ({ fake, memory, auth }) =>
      Effect.gen(function* () {
        const gate = yield* gateRefresh(fake, tokens(RENEWED, ROTATED));
        yield* fake.reply("auth:signOut", Reply.Success({ value: null }));
        const refreshing = yield* Effect.forkChild(auth.accessToken(true));

        yield* Deferred.await(gate.arrived);
        // Sign-out finishes while the refresh is still waiting on the server.
        yield* auth.signOut;
        yield* Deferred.succeed(gate.release, undefined);

        expect(yield* Fiber.join(refreshing)).toStrictEqual(Option.none());
        expect(yield* auth.currentStatus).toBe("signedOut");
        expect(yield* auth.accessToken(false)).toStrictEqual(Option.none());
        expect(memory.saved()).toStrictEqual(Option.none());
      }),
    ));

  it("does not overwrite another account's session when a refresh lands after sign-in", () =>
    withAuth(signedInWith(FRESH), ({ fake, memory, auth }) =>
      Effect.gen(function* () {
        const gate = yield* gateRefresh(fake, tokens(RENEWED, ROTATED));
        const sam = jwtExpiringAt(START + 3_600_000, "sam");
        const refreshing = yield* Effect.forkChild(auth.accessToken(true));

        yield* Deferred.await(gate.arrived);
        yield* auth.signIn(Auth.Credentials.ApiKey({ key: Redacted.make("sam-key") }));
        yield* Deferred.succeed(gate.release, undefined);

        expect(reveal(yield* Fiber.join(refreshing))).toBe(sam);
        expect(reveal(yield* auth.accessToken(false))).toBe(sam);
        expect(memory.saved()).toStrictEqual(
          Option.some({ token: sam, refreshToken: "sam-refresh" }),
        );
      }),
    ));

  it("does not sign another account out when a stale refresh is refused", () =>
    withAuth(signedInWith(FRESH), ({ fake, memory, auth }) =>
      Effect.gen(function* () {
        const gate = yield* gateRefresh(fake, Reply.Success({ value: { tokens: null } }));
        const sam = jwtExpiringAt(START + 3_600_000, "sam");
        const refreshing = yield* Effect.forkChild(auth.accessToken(true));

        yield* Deferred.await(gate.arrived);
        yield* auth.signIn(Auth.Credentials.ApiKey({ key: Redacted.make("sam-key") }));
        yield* Deferred.succeed(gate.release, undefined);

        expect(reveal(yield* Fiber.join(refreshing))).toBe(sam);
        expect(yield* auth.currentStatus).toBe("signedIn");
        expect(memory.saved()).toStrictEqual(
          Option.some({ token: sam, refreshToken: "sam-refresh" }),
        );
      }),
    ));

  it("signs out on the server with a renewed token when the stored one expired", () =>
    withAuth(signedInWith(EXPIRED), ({ fake, memory, auth }) =>
      Effect.gen(function* () {
        yield* fake.reply("auth:signIn", tokens(RENEWED, ROTATED));
        yield* fake.reply("auth:signOut", Reply.Success({ value: null }));

        yield* auth.signOut;

        expect((yield* fake.requestsTo("auth:signOut")).map((r) => r.authorization)).toStrictEqual([
          `Bearer ${RENEWED}`,
        ]);
        expect(yield* auth.currentStatus).toBe("signedOut");
        expect(memory.saved()).toStrictEqual(Option.none());
      }),
    ));

  it("still signs out locally when storing the renewed token fails", () =>
    withAuth(signedInWith(EXPIRED), ({ fake, memory, auth }) =>
      Effect.gen(function* () {
        yield* fake.reply("auth:signIn", tokens(RENEWED, ROTATED));
        yield* fake.reply("auth:signOut", Reply.Success({ value: null }));
        memory.failWrites(true);

        yield* auth.signOut;

        expect((yield* fake.requestsTo("auth:signOut")).map((r) => r.authorization)).toStrictEqual([
          `Bearer ${RENEWED}`,
        ]);
        expect(yield* auth.currentStatus).toBe("signedOut");
        expect(memory.saved()).toStrictEqual(Option.none());
      }),
    ));

  it("keeps the rotated refresh token in memory when storing it fails", () =>
    withAuth(signedInWith(EXPIRING), ({ fake, memory, auth }) =>
      Effect.gen(function* () {
        yield* fake.reply("auth:signIn", tokens(RENEWED, ROTATED));
        memory.failWrites(true);

        const failure = yield* Effect.flip(auth.accessToken(false));

        expect(failure).toMatchObject({ _tag: "TokenStorageError", operation: "save" });
        // The server rotated the refresh token, so the next refresh has to send the new one.
        expect(reveal(yield* auth.accessToken(false))).toBe(RENEWED);
        yield* Effect.exit(auth.accessToken(true));
        expect(yield* refreshRequests(fake)).toStrictEqual(["refresh-1", ROTATED]);
      }),
    ));

  it("authorizes calls with the renewed token even when storing it fails", () =>
    withAuth(signedInWith(EXPIRING), ({ fake, memory }) =>
      Effect.gen(function* () {
        yield* fake.reply("auth:signIn", tokens(RENEWED, ROTATED));
        yield* fake.reply("deviceAuth:status", Reply.Success({ value: { state: "pending" } }));
        memory.failWrites(true);
        const client = yield* MoviesClient;

        yield* client.query("deviceAuth.status", { deviceCode: "device-secret" });

        expect(
          (yield* fake.requestsTo("deviceAuth:status")).map((request) => request.authorization),
        ).toStrictEqual([`Bearer ${RENEWED}`]);
      }),
    ));

  it("signs out locally at once while the server is slow to renew the token", () =>
    withAuth(signedInWith(EXPIRING), ({ fake, memory, auth }) =>
      Effect.gen(function* () {
        const gate = yield* gateRefresh(fake, tokens(RENEWED, ROTATED));

        yield* fake.reply("auth:signOut", Reply.Success({ value: null }));
        const signingOut = yield* Effect.forkChild(auth.signOut);

        yield* Deferred.await(gate.arrived);

        expect(yield* auth.currentStatus).toBe("signedOut");
        expect(memory.saved()).toStrictEqual(Option.none());

        // The server sign-out gives up on a hung server instead of waiting forever.
        yield* TestClock.adjust(60_000);
        yield* Fiber.join(signingOut);
      }),
    ));

  it("keeps a sign-in that lands while the server is ending the previous session", () =>
    withAuth(signedInWith(FRESH), ({ fake, memory, auth }) =>
      Effect.gen(function* () {
        const arrived = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const sam = jwtExpiringAt(START + 3_600_000, "sam");

        yield* fake.reply("auth:signIn", tokens(sam, "sam-refresh"));
        yield* fake.handle("auth:signOut", () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(arrived, undefined);
            yield* Deferred.await(release);

            return Reply.Success({ value: null });
          }),
        );
        const signingOut = yield* Effect.forkChild(auth.signOut);

        yield* Deferred.await(arrived);
        yield* auth.signIn(Auth.Credentials.ApiKey({ key: Redacted.make("sam-key") }));
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(signingOut);

        expect(yield* auth.currentStatus).toBe("signedIn");
        expect(reveal(yield* auth.accessToken(false))).toBe(sam);
        expect(memory.saved()).toStrictEqual(
          Option.some({ token: sam, refreshToken: "sam-refresh" }),
        );
      }),
    ));

  it("shares a refresh that got no answer with the callers waiting behind it", () =>
    withAuth(signedInWith(EXPIRING), ({ fake, auth }) =>
      Effect.gen(function* () {
        const gate = yield* gateRefresh(fake, tokens(RENEWED, ROTATED));

        const callers = yield* Effect.forkChild(
          Effect.all([auth.accessToken(false), auth.accessToken(false), auth.accessToken(false)], {
            concurrency: "unbounded",
          }),
        );

        yield* Deferred.await(gate.arrived);
        yield* TestClock.adjust(30_001);
        yield* TestClock.withLive(Effect.sleep(50));

        expect(yield* refreshRequests(fake)).toStrictEqual(["refresh-1"]);
        expect((yield* Fiber.join(callers)).map(reveal)).toStrictEqual([
          EXPIRING,
          EXPIRING,
          EXPIRING,
        ]);
      }),
    ));

  it("drops a refused session from memory even when clearing storage fails", () =>
    withAuth(signedInWith(EXPIRING), ({ fake, memory, auth }) =>
      Effect.gen(function* () {
        yield* fake.reply("auth:signIn", Reply.Success({ value: { tokens: null } }));
        memory.failClears(true);

        yield* Effect.exit(auth.accessToken(false));

        expect(yield* auth.currentStatus).toBe("signedOut");
        expect(yield* auth.accessToken(false)).toStrictEqual(Option.none());
        expect(yield* refreshRequests(fake)).toStrictEqual(["refresh-1"]);
      }),
    ));

  it("ends on the server a session renewed after sign-out forgot it", () =>
    withAuth(signedInWith(FRESH), ({ fake, auth }) =>
      Effect.gen(function* () {
        const gate = yield* gateRefresh(fake, tokens(RENEWED, ROTATED));

        yield* fake.reply("auth:signOut", Reply.Success({ value: null }));
        const refreshing = yield* Effect.forkChild(auth.accessToken(true));

        yield* Deferred.await(gate.arrived);
        yield* auth.signOut;
        yield* Deferred.succeed(gate.release, undefined);

        expect(yield* Fiber.join(refreshing)).toStrictEqual(Option.none());

        // The renewed session is ended in the background; give it a moment on the real clock.
        for (let tries = 0; tries < 20; tries += 1) {
          if ((yield* fake.requestsTo("auth:signOut")).length >= 2) break;
          yield* TestClock.withLive(Effect.sleep(20));
        }

        expect((yield* fake.requestsTo("auth:signOut")).map((r) => r.authorization)).toStrictEqual([
          `Bearer ${FRESH}`,
          `Bearer ${RENEWED}`,
        ]);
      }),
    ));

  it("renews for a caller whose token was rejected even after another refresh kept it", () =>
    withAuth(signedInWith(EXPIRING), ({ fake, auth }) =>
      Effect.gen(function* () {
        const arrived = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const count = yield* Ref.make(0);

        yield* fake.handle("auth:signIn", () =>
          Effect.gen(function* () {
            const index = yield* Ref.getAndUpdate(count, (n) => n + 1);

            if (index > 0) return tokens(RENEWED, ROTATED);
            yield* Deferred.succeed(arrived, undefined);
            yield* Deferred.await(release);

            // A blip: the first refresh never gets an answer.
            return Reply.Drop();
          }),
        );

        const expiring = yield* Effect.forkChild(auth.accessToken(false));

        yield* Deferred.await(arrived);
        const rejected = yield* Effect.forkChild(auth.accessToken(true));

        yield* TestClock.withLive(Effect.sleep(20));
        yield* Deferred.succeed(release, undefined);

        expect(reveal(yield* Fiber.join(expiring))).toBe(EXPIRING);
        expect(reveal(yield* Fiber.join(rejected))).toBe(RENEWED);
      }),
    ));

  it("logs a token storage failure without its cause", () =>
    withAuth(signedInWith(EXPIRING), ({ fake, memory, logs }) =>
      Effect.gen(function* () {
        yield* fake.reply("auth:signIn", tokens(RENEWED, ROTATED));
        yield* fake.reply("deviceAuth:status", Reply.Success({ value: { state: "pending" } }));
        memory.failWrites(true);
        const client = yield* MoviesClient;

        yield* client.query("deviceAuth.status", { deviceCode: "device-secret" });

        const warnings = logs().filter((entry) => entry.includes("Auth.tokenStorageFailed"));

        expect(warnings).toHaveLength(1);
        expect(warnings[0]).not.toContain(RENEWED);
        expect(warnings[0]).not.toContain(ROTATED);
      }),
    ));
});
