import { createServer } from "node:http";

import { NodeHttpServer } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpClient, HttpRouter, HttpServer, HttpServerResponse } from "effect/http";

import * as Outbound from "./outbound.ts";

const redirecting = HttpRouter.serve(
  HttpRouter.add(
    "GET",
    "/poster.jpg",
    HttpServerResponse.redirect("http://169.254.169.254/latest/meta-data", { status: 302 }),
  ),
  { disableLogger: true, disableListenLog: true },
).pipe(Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0, host: "127.0.0.1" })));

describe("outbound requests", () => {
  layer(Layer.mergeAll(redirecting, Outbound.layer), { excludeTestServices: true })((it) => {
    it.effect("hand a redirect back instead of following it to another host", () =>
      Effect.gen(function* () {
        const baseUrl = yield* HttpServer.addressFormattedWith(Effect.succeed);
        const response = yield* HttpClient.get(`${baseUrl}/poster.jpg`).pipe(Effect.orDie);

        assert.strictEqual(response.status, 302);
        assert.strictEqual(response.headers["location"], "http://169.254.169.254/latest/meta-data");
      }),
    );
  });
});
