import { createServer } from "node:http";
import { request as nodeRequest } from "node:http";

import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { assert, describe, it, layer } from "@effect/vitest";
import { Context, Effect, Layer, Option } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import { testConfigLayer } from "../testing/test-config.ts";
import * as Hardening from "./hardening.ts";

class Site extends Context.Service<Site, { readonly baseUrl: string }>()("test/HardeningSite") {}

/** A route that reads its whole body, as the HttpApi routes do, behind the hardening layer. */
const echo = HttpRouter.add(
  "POST",
  "/echo",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.text;

    return HttpServerResponse.text(String(body.length));
  }).pipe(Effect.orDie),
);

const siteLayer = Layer.unwrap(
  Effect.sync(() => {
    const server = HttpRouter.serve(Layer.mergeAll(echo, Hardening.layer), {
      disableLogger: true,
      disableListenLog: true,
    }).pipe(
      Layer.provide(
        testConfigLayer({
          MEDIA_BASE_URL: "http://media.test:4300",
          CONVEX_PUBLIC_URL: "https://convex.test",
        }),
      ),
      Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0, host: "127.0.0.1" })),
    );

    const site = Layer.effect(
      Site,
      HttpServer.addressFormattedWith((baseUrl) => Effect.succeed(Site.of({ baseUrl }))),
    );

    return site.pipe(Layer.provideMerge(server));
  }),
).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)));

const postText = Effect.fn(function* (body: string) {
  const { baseUrl } = yield* Site;

  const response = yield* HttpClient.execute(
    HttpClientRequest.post(`${baseUrl}/echo`).pipe(HttpClientRequest.bodyText(body)),
  ).pipe(Effect.orDie);

  return { status: response.status, headers: response.headers };
});

/** Posts a chunked body with Node's client, which `fetch` cannot send without a stream. */
const postChunked = Effect.fn(function* () {
  const { baseUrl } = yield* Site;

  return yield* Effect.callback<number>((resume) => {
    const outgoing = nodeRequest(`${baseUrl}/echo`, { method: "POST" }, (incoming) => {
      incoming.resume();
      resume(Effect.succeed(incoming.statusCode ?? 0));
    });

    outgoing.write("a".repeat(1024));
    outgoing.end();
  });
});

describe("hardening", () => {
  layer(siteLayer, { excludeTestServices: true })((served) => {
    served.effect("accepts bodies up to the cap and refuses larger or chunked ones", () =>
      Effect.gen(function* () {
        assert.strictEqual((yield* postText("{}")).status, 200);
        assert.strictEqual(
          (yield* postText("a".repeat(Hardening.MAX_REQUEST_BODY_BYTES))).status,
          200,
        );
        assert.strictEqual(
          (yield* postText("a".repeat(Hardening.MAX_REQUEST_BODY_BYTES + 1))).status,
          413,
        );
        assert.strictEqual(yield* postChunked(), 411);
      }),
    );

    served.effect("adds the security headers to answers and to refusals", () =>
      Effect.gen(function* () {
        const answered = yield* postText("{}");
        const refused = yield* postText("a".repeat(Hardening.MAX_REQUEST_BODY_BYTES + 1));

        for (const headers of [answered.headers, refused.headers]) {
          assert.strictEqual(headers["x-content-type-options"], "nosniff");
          assert.strictEqual(headers["referrer-policy"], "no-referrer");
          assert.strictEqual(headers["x-frame-options"], "DENY");
          assert.include(headers["content-security-policy"], "frame-ancestors 'none'");
        }
      }),
    );
  });

  it("allows scripts from this origin and the Cast SDK's, and connections to the configured Convex", () => {
    const policy = Hardening.contentSecurityPolicy({
      mediaBaseUrl: "http://nas:4300",
      convexPublicUrl: Option.some("https://convex.example/"),
    });

    assert.include(policy, "script-src 'self' www.gstatic.com;");
    assert.include(
      policy,
      "connect-src 'self' http://nas:4300 https://convex.example wss://convex.example;",
    );
    assert.include(policy, "media-src 'self' blob: http://nas:4300;");
    // Trailers embed YouTube's cookieless player and nothing else.
    assert.include(policy, "frame-src https://www.youtube-nocookie.com;");
    assert.notInclude(policy, "unsafe-eval");

    const open = Hardening.contentSecurityPolicy({
      mediaBaseUrl: "http://nas:4300",
      convexPublicUrl: Option.none(),
    });

    assert.include(open, "connect-src 'self' http://nas:4300 http: https: ws: wss:");
  });
});
