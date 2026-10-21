import { assert, describe, layer } from "@effect/vitest";
import type { LogRecord } from "@movies/contracts/diagnostics";
import { Effect, Predicate } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import * as MediaTestServer from "../testing/media-test-server.ts";

/** The path a request record names; empty for any other record. */
const urlOf = (record: LogRecord): string => {
  const url = record.annotations["http.url"];

  return Predicate.isString(url) ? url : "";
};

/** A path as long as a stranger may send: the service's own segment route with a 15 KB name. */
const LONG_NAME = "x".repeat(15_000);

const flood = Effect.gen(function* () {
  const server = yield* MediaTestServer.Service;
  const client = yield* HttpClient.HttpClient;

  const statuses = yield* Effect.forEach(
    [
      `/media/hls/${LONG_NAME}/1/index.m3u8?token=not-a-token`,
      `/media/file/${LONG_NAME}?token=not-a-token`,
      `/no-such-route/${LONG_NAME}`,
    ],
    (path) =>
      client
        .execute(HttpClientRequest.get(`${server.baseUrl}${path}`))
        .pipe(Effect.map((response) => response.status)),
    { concurrency: "unbounded" },
  );

  assert.isTrue(statuses.every((status) => status >= 400 && status < 500));

  return server.logged();
});

describe("request log", () => {
  layer(MediaTestServer.layer(), { excludeTestServices: true, timeout: "60 seconds" })((it) => {
    it.effect("keeps nothing a caller without a token sends at the default level", () =>
      Effect.gen(function* () {
        const logged = yield* flood;

        assert.deepStrictEqual(
          logged.filter((record) => JSON.stringify(record).includes(LONG_NAME.slice(0, 200))),
          [],
        );
        assert.deepStrictEqual(
          logged.filter((record) => record.annotations["http.url"] !== undefined),
          [],
        );
      }),
    );
  });

  layer(MediaTestServer.layer({ LOG_LEVEL: "debug" }), {
    excludeTestServices: true,
    timeout: "60 seconds",
  })((it) => {
    it.effect("logs each response at DEBUG with its path cut short and no query", () =>
      Effect.gen(function* () {
        const logged = yield* flood;

        const access = logged.filter((record) => urlOf(record) !== "");

        assert.isAtLeast(access.length, 3);

        for (const record of access) {
          const url = urlOf(record);

          assert.strictEqual(record.level, "DEBUG");
          assert.isAtMost(url.length, 129);
          assert.notInclude(url, "?");
          assert.isNumber(record.annotations["http.status"]);
          assert.isNumber(record.annotations["elapsedMs"]);
        }

        assert.isTrue(access.some((record) => urlOf(record).startsWith("/media/hls/xxxx")));
      }),
    );
  });
});
