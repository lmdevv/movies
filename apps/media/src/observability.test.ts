import { createServer } from "node:http";

import { describe, expect, it } from "@effect/vitest";
import { Console, Effect, Layer, Predicate, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";

import * as Observability from "./observability.ts";
import { testConfigLayer } from "./testing/test-config.ts";

/** `text` as base64url, the encoding of signed tokens' parts. */
const base64url = (text: string): string => Buffer.from(text, "utf8").toString("base64url");

/**
 * Values that must never reach a log line or an export, in the shapes they really take. They are
 * made up; the token is built here so no token-shaped literal sits in the source.
 */
const secrets = {
  playbackToken: `${base64url('{"aud":"media"}')}.${base64url("signature-secret")}`,
  apiKey: "mk_AbCdEfGh_0123456789abcdefghijklmnopqrstuv",
  adminKey: "convex-self-hosted|0123456789abcdef0123456789abcdef0123456789abcdef",
  tmdbKey: "tmdb0123456789secretkey",
  plexToken: "plexSecretTokenValue",
  jellyfinToken: "jellyfinSecretTokenValue",
  password: "hunter2-password-value",
};

/** A failure whose message carries a secret, as a careless CLI error might. */
class ImportFailed extends Schema.TaggedError<ImportFailed>()("ImportFailed", {
  output: Schema.String,
}) {
  override get message(): string {
    return `convex import failed: ${this.output}`;
  }
}

/** Logs every secret the ways careless code might: in messages, annotations, and causes. */
const logEverySecret = Effect.gen(function* () {
  yield* Effect.logWarning(
    "Request.failed",
    `GET /media/hls/abc/1/index.m3u8?token=${secrets.playbackToken}`,
    `https://api.themoviedb.org/3/search/movie?query=x&api_key=${secrets.tmdbKey}`,
    `http://plex.local:32400/library/sections?X-Plex-Token=${secrets.plexToken}`,
    `Authorization: MediaBrowser Client="movies", Token="${secrets.jellyfinToken}"`,
    `Authorization: Bearer ${secrets.apiKey}`,
    `admin key ${secrets.adminKey}`,
  ).pipe(
    Effect.annotateLogs({
      apiKey: secrets.apiKey,
      password: secrets.password,
      nested: { authorization: `Bearer ${secrets.apiKey}`, password: secrets.password },
      fileId: "file_123",
    }),
  );

  yield* Effect.logError("Backups.failed", Redacted.make(secrets.adminKey)).pipe(
    Effect.andThen(new ImportFailed({ output: `admin key ${secrets.adminKey}` })),
    Effect.catchCause((cause) => Effect.logError("Backups.failed", cause)),
  );
});

/** A console that keeps every line logged to it. */
const recordingConsole = (lines: Array<string>): Console.Console => ({
  ...globalThis.console,
  log: (...args: ReadonlyArray<unknown>) => {
    lines.push(args.join(" "));
  },
});

/** `effect` run with the observability layer for `env` and an HTTP client, and the console lines it wrote. */
const runObserved = (
  effect: Effect.Effect<void, never, HttpClient.HttpClient>,
  env: Readonly<Record<string, string>>,
) =>
  Effect.gen(function* () {
    const lines: Array<string> = [];

    // The layer's scope closes before the lines are returned, which flushes any exporter.
    yield* Effect.gen(function* () {
      const context = yield* Layer.build(
        Layer.provideMerge(
          Observability.layer,
          Layer.merge(testConfigLayer(env), FetchHttpClient.layer),
        ),
      );

      yield* effect.pipe(Effect.provideContext(context));
    }).pipe(Effect.scoped, Effect.provideService(Console.Console, recordingConsole(lines)));

    return lines.join("\n");
  });

/** A local OTLP/HTTP receiver that keeps every export it is sent and answers anything else. */
const otlpReceiver = Effect.acquireRelease(
  Effect.callback<{ readonly url: string; readonly bodies: Array<string>; close: () => void }>(
    (resume) => {
      const bodies: Array<string> = [];

      const server = createServer((request, response) => {
        const chunks: Array<Buffer> = [];

        request.on("data", (chunk: Buffer) => chunks.push(chunk));

        request.on("end", () => {
          const path = request.url ?? "";

          if (path.startsWith("/v1/")) {
            bodies.push(`${path} ${Buffer.concat(chunks).toString("utf8")}`);
          }

          response.writeHead(200, { "content-type": "application/json" }).end("{}");
        });
      });

      server.listen(0, "127.0.0.1", () => {
        const address = server.address();

        if (address === null || Predicate.isString(address)) {
          resume(Effect.die("The OTLP receiver is not listening on a TCP port"));
        } else {
          resume(
            Effect.succeed({
              url: `http://127.0.0.1:${String(address.port)}`,
              bodies,
              close: () => server.close(),
            }),
          );
        }
      });
    },
  ),
  (receiver) => Effect.sync(receiver.close),
);

describe("Observability", () => {
  it.effect("writes one JSON object per log line", () =>
    Effect.gen(function* () {
      const output = yield* runObserved(
        Effect.logInfo("JobWorker.ready").pipe(Effect.annotateLogs({ workerId: "w1" })),
        {},
      );

      expect(JSON.parse(output)).toMatchObject({
        message: "JobWorker.ready",
        level: "INFO",
        annotations: { workerId: "w1" },
      });
    }),
  );

  it.effect("never writes a token, API key, password, or admin key to the console", () =>
    Effect.gen(function* () {
      const output = yield* runObserved(logEverySecret, {});

      for (const [name, secret] of Object.entries(secrets)) {
        expect(output, name).not.toContain(secret);
      }

      // Everything else stays readable.
      expect(output).toContain("Request.failed");
      expect(output).toContain("Backups.failed");
      expect(output).toContain("api.themoviedb.org/3/search/movie?query=x");
      expect(output).toContain("file_123");
    }),
  );

  it.live("exports spans and logs over OTLP without any secret", () =>
    Effect.gen(function* () {
      const receiver = yield* otlpReceiver;

      yield* runObserved(
        Effect.gen(function* () {
          yield* logEverySecret.pipe(
            Effect.withSpan("Backups.backup", { attributes: { trigger: "manual" } }),
          );

          // The HTTP client records `url.full` and `url.query` itself, as the HTTP server does.
          yield* HttpClient.get(
            `${receiver.url}/media/hls/abc/1/index.m3u8?token=${secrets.playbackToken}`,
            { headers: { "x-plex-token": secrets.plexToken } },
          ).pipe(Effect.orDie);

          yield* new ImportFailed({ output: `admin key ${secrets.adminKey}` }).pipe(
            Effect.withSpan("Backups.restore", { attributes: { password: secrets.password } }),
            Effect.ignore,
          );
        }),
        { OTEL_EXPORTER_OTLP_ENDPOINT: receiver.url },
      );

      const exported = receiver.bodies.join("\n");

      expect(exported).toContain("/v1/traces");
      expect(exported).toContain("Backups.backup");
      expect(exported).toContain("Backups.restore");
      expect(exported).toContain("/media/hls/abc/1/index.m3u8");
      expect(exported).toContain("/v1/logs");
      expect(exported).toContain("Request.failed");

      for (const [name, secret] of Object.entries(secrets)) {
        expect(exported, name).not.toContain(secret);
      }
    }).pipe(Effect.scoped),
  );
});
