import { Effect, Fiber, Layer, Option, Queue, Ref } from "effect";
import type { Scope } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import * as Auth from "./auth";
import * as DeviceLogin from "./device-login";
import * as Movies from "./movies";
import * as FakeConvex from "./testing/fake-convex";
import { jwtExpiringAt, Reply } from "./testing/fake-convex";
import * as TokenStorage from "./token-storage";

const START = 1_760_000_000_000;

/** The server lets a device sign-in wait ten minutes. */
const EXPIRES_AT = START + 600_000;

const TOKEN = jwtExpiringAt(START + 3_600_000);

/** Runs `body` on the test clock against a fake deployment that hands out one device code. */
const withDeviceLogin = <A, E>(
  body: (
    fake: FakeConvex.FakeConvex,
  ) => Effect.Effect<A, E, Movies.Services | TestClock.TestClock | Scope.Scope>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const testClock = yield* Layer.build(TestClock.layer());

        return yield* Effect.gen(function* () {
          yield* TestClock.setTime(START);
          const fake = yield* FakeConvex.make;

          yield* fake.reply(
            "deviceAuth:request",
            Reply.Success({
              value: {
                deviceCode: "device-secret",
                userCode: "ABCD-EFGH",
                verificationUrl: "https://movies.example.com/device",
                expiresAt: EXPIRES_AT,
              },
            }),
          );
          yield* fake.reply(
            "auth:signIn",
            Reply.Success({ value: { tokens: { token: TOKEN, refreshToken: "refresh-1" } } }),
          );

          const sdk = yield* Layer.build(
            Movies.layer({ convexUrl: fake.url, mediaUrl: Option.none(), connection: "http" }).pipe(
              Layer.provide(TokenStorage.layerMemory),
            ),
          );

          return yield* body(fake).pipe(Effect.provideContext(sdk));
        }).pipe(Effect.provideContext(testClock));
      }),
    ),
  );

/** Answers each `deviceAuth:status` poll with the next reply, repeating the last, and reports it. */
const scriptStatus = (fake: FakeConvex.FakeConvex, replies: ReadonlyArray<Reply>) =>
  Effect.gen(function* () {
    const polls = yield* Queue.unbounded<number>();
    const count = yield* Ref.make(0);

    yield* fake.handle("deviceAuth:status", () =>
      Effect.gen(function* () {
        const index = yield* Ref.getAndUpdate(count, (n) => n + 1);

        yield* Queue.offer(polls, index);

        return replies[Math.min(index, replies.length - 1)] ?? Reply.Drop();
      }),
    );

    return polls;
  });

const state = (value: string): Reply => Reply.Success({ value: { state: value } });

/**
 * Moves the test clock in half-second steps, giving the network real time between them, until
 * `polls` reports poll number `index` or twenty seconds have passed on the test clock.
 */
const advanceUntilPoll = (polls: Queue.Queue<number>, index: number) =>
  Effect.gen(function* () {
    for (let step = 0; step < 40; step += 1) {
      const seen = yield* Queue.clear(polls);

      if (seen.some((n) => n >= index)) return;
      yield* TestClock.adjust(500);
      yield* TestClock.withLive(Effect.sleep(20));
    }
  });

describe("DeviceLogin", () => {
  it("signs in with the device code once the sign-in is approved", () =>
    withDeviceLogin((fake) =>
      Effect.gen(function* () {
        yield* scriptStatus(fake, [state("pending"), state("approved")]);
        const login = yield* DeviceLogin.start("Living room TV");

        expect(login).toMatchObject({
          userCode: "ABCD-EFGH",
          verificationUrl: "https://movies.example.com/device",
          expiresAt: EXPIRES_AT,
        });

        yield* login.complete;

        expect(yield* Effect.flatMap(Auth.Auth, (auth) => auth.currentStatus)).toBe("signedIn");
        expect(
          (yield* fake.requestsTo("auth:signIn")).map((request) => request.args),
        ).toStrictEqual([{ provider: "device", params: { deviceCode: "device-secret" } }]);
      }),
    ));

  it("fails with DeviceLoginRefused when the sign-in is denied", () =>
    withDeviceLogin((fake) =>
      Effect.gen(function* () {
        yield* scriptStatus(fake, [state("denied")]);
        const login = yield* DeviceLogin.start("Living room TV");

        const failure = yield* Effect.flip(login.complete);

        expect(failure).toMatchObject({
          _tag: "DeviceLoginRefused",
          state: "denied",
          message: "Device sign-in denied: start a new sign-in",
        });
        expect(yield* fake.requestsTo("auth:signIn")).toStrictEqual([]);
      }),
    ));

  it("gives up as expired when nobody approves before the code expires", () =>
    withDeviceLogin((fake) =>
      Effect.gen(function* () {
        const polls = yield* scriptStatus(fake, [state("pending")]);
        const login = yield* DeviceLogin.start("Living room TV");
        const waiting = yield* Effect.forkChild(Effect.flip(login.complete));

        yield* Queue.take(polls);
        yield* TestClock.adjust(EXPIRES_AT - START + 5_001);

        expect(yield* Fiber.join(waiting)).toMatchObject({
          _tag: "DeviceLoginRefused",
          state: "expired",
        });
        expect(yield* fake.requestsTo("auth:signIn")).toStrictEqual([]);
      }),
    ));

  it("keeps watching after one status poll fails in transit", () =>
    withDeviceLogin((fake) =>
      Effect.gen(function* () {
        const polls = yield* scriptStatus(fake, [Reply.Drop(), state("approved")]);
        const login = yield* DeviceLogin.start("Living room TV");
        const waiting = yield* Effect.forkChild(Effect.exit(login.complete));

        yield* advanceUntilPoll(polls, 1);
        const exit = yield* Fiber.join(waiting);

        expect(exit).toMatchObject({ _tag: "Success" });
        expect(yield* Effect.flatMap(Auth.Auth, (auth) => auth.currentStatus)).toBe("signedIn");
      }),
    ));
});
