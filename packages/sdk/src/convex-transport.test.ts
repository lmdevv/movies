import { ConvexError } from "convex/values";
import { Context, Duration, Effect, Layer, Predicate, Redacted } from "effect";
import { describe, expect, it } from "vitest";

import * as Auth from "./auth";
import * as ConvexTransport from "./convex-transport";
import { translateFailure } from "./convex-transport";
import * as FakeConvex from "./testing/fake-convex";
import { jwtIssuedAt, Reply } from "./testing/fake-convex";
import * as TokenStorage from "./token-storage";

/** Long enough for the client's ten-second refresh leeway, short enough to outlive in a test. */
const TOKEN_LIFETIME_SECONDS = 12;

const mintToken = (): Reply =>
  Reply.Success({
    value: {
      tokens: {
        token: jwtIssuedAt(Date.now(), TOKEN_LIFETIME_SECONDS, "service|session"),
        refreshToken: "refresh",
      },
    },
  });

/**
 * Signs in over a WebSocket connection to a fake Convex whose `auth:signIn` answers with
 * `signIn`, then asks a query once the first token has expired.
 */
const askAfterFirstTokenExpires = (signIn: (request: { readonly args: unknown }) => Reply) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* FakeConvex.make;

        yield* fake.handle("auth:signIn", (request) => Effect.sync(() => signIn(request)));
        yield* fake.reply("account:viewer", Reply.Success({ value: "signed in" }));

        const context = yield* Layer.build(
          Auth.layer({ convexUrl: fake.url }).pipe(
            Layer.provideMerge(ConvexTransport.layerWebSocket(fake.url)),
            Layer.provide(TokenStorage.layerMemory),
          ),
        );

        const auth = Context.get(context, Auth.Auth);
        const transport = Context.get(context, ConvexTransport.ConvexTransport);
        const viewer = transport.call("query", "account:viewer", {});

        // Start at the top of a second, so the sign-in and the client's first refresh share it.
        yield* Effect.sleep(Duration.millis(1000 - (Date.now() % 1000)));
        yield* auth.signIn(Auth.Credentials.ApiKey({ key: Redacted.make("mk_service") }));
        const signedInAt = Date.now();

        expect(yield* viewer).toBe("signed in");

        yield* Effect.sleep(
          Duration.millis(signedInAt + (TOKEN_LIFETIME_SECONDS + 1) * 1000 - Date.now()),
        );

        const later = yield* viewer.pipe(Effect.timeout(Duration.seconds(5)));

        expect(new Set(yield* fake.acceptedTokens).size).toBeGreaterThan(1);

        return later;
      }),
    ),
  );

describe.concurrent("layerWebSocket", () => {
  it("keeps a session working when a refresh in its sign-in second mints the same token", async () => {
    // Convex Auth signs to the second, so that refresh returns the sign-in's very token.
    expect(await askAfterFirstTokenExpires(mintToken)).toBe("signed in");
  }, 30_000);

  it("keeps a session working when refreshing fails for a while", async () => {
    let failingUntil = Number.POSITIVE_INFINITY;

    const answer = await askAfterFirstTokenExpires(({ args }) => {
      if (!Predicate.hasProperty(args, "refreshToken")) {
        failingUntil = Date.now() + 4000;

        return mintToken();
      }

      return Date.now() < failingUntil ? Reply.Crash({ message: "Convex is busy" }) : mintToken();
    });

    expect(answer).toBe("signed in");
  }, 30_000);
});

describe("translateFailure", () => {
  it("turns ConvexError data into the command error for its code", () => {
    const error = translateFailure(
      "rooms:play",
      new ConvexError({ code: "stale_revision", message: "The room changed" }),
    );

    expect(error).toMatchObject({ _tag: "StaleRevision", message: "The room changed" });
  });

  it("reports ConvexError data without a known code as a protocol error", () => {
    expect(translateFailure("x:y", new ConvexError({ code: "nope", message: "?" }))).toMatchObject({
      _tag: "ProtocolError",
    });
  });

  it("treats Convex rejecting the token as a signed-out session", () => {
    const rejected = new Error(
      JSON.stringify({ code: "Unauthenticated", message: "Could not verify OIDC token claim" }),
    );

    expect(translateFailure("account:viewer", rejected)).toMatchObject({ _tag: "Unauthenticated" });
  });

  it("reports an argument that is not an ID of its table as not found", () => {
    const overHttp = new Error(
      '[Request ID: 55c324b842b35e1b] Server Error\nArgumentValidationError: Value does not match validator.\nPath: .titleId\nValue: "nope"\nValidator: v.id("titles")\n\n',
    );

    const overWebSocket = new Error(
      '[CONVEX Q(titles:get)] [Request ID: 8d858a8ee2675929] Server Error\nArgumentValidationError: Value does not match validator.\nPath: .profileId\nValue: "nope"\nValidator: v.id("profiles")\n\n\n  Called by client',
    );

    const fromAnotherTable = new Error(
      '[Request ID: af9a287f7de12fe1] Server Error\nArgumentValidationError: Found ID "md72x7j3s82e23sy3q1h1y2r7d8g7jvw" from table `profiles`, which does not match the table name in validator `v.id("titles")`.Path: .titleId\n\n',
    );

    expect(translateFailure("titles:get", overHttp)).toMatchObject({
      _tag: "NotFound",
      message: "No such item: nothing has that ID",
    });
    expect(translateFailure("titles:get", overWebSocket)).toMatchObject({
      _tag: "NotFound",
      message: "No such item: nothing has that ID",
    });
    expect(translateFailure("titles:get", fromAnotherTable)).toMatchObject({
      _tag: "NotFound",
      message: "No such item: nothing has that ID",
    });
  });

  it("keeps other argument failures and crashes internal", () => {
    const badNumber = new Error(
      '[Request ID: 1] Server Error\nArgumentValidationError: Value does not match validator.\nPath: .limit\nValue: "x"\nValidator: v.number()\n\n',
    );

    const crashMentioningIds = new Error(
      '[Request ID: 1] Server Error\nUncaught Error: expected Validator: v.id("titles")',
    );

    expect(translateFailure("x:y", badNumber)).toMatchObject({ _tag: "Internal" });
    expect(translateFailure("x:y", crashMentioningIds)).toMatchObject({ _tag: "Internal" });
  });

  it("separates crashed functions from network failures", () => {
    expect(translateFailure("x:y", new Error("[Request ID: 1] Server Error"))).toMatchObject({
      _tag: "Internal",
    });
    expect(translateFailure("x:y", new TypeError("fetch failed"))).toMatchObject({
      _tag: "TransportError",
    });
  });
});
