/**
 * The log and diagnostics routes over HTTP, against a real retained log and an authorizer that
 * knows three bearer tokens: an admin's, a member's (who owns `session_a`), and another member's.
 */
import { createServer } from "node:http";

import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { assert, layer } from "@effect/vitest";
import { DiagnosedSession, PlaybackDiagnostics } from "@movies/contracts/diagnostics";
import { Forbidden, Unauthenticated } from "@movies/contracts/errors";
import { AuthSessionId, UserId } from "@movies/contracts/ids";
import type { Viewer } from "@movies/contracts/models/account";
import { type Role, roleScopes } from "@movies/contracts/scopes";
import { EpochMillis } from "@movies/contracts/units";
import { Context, Duration, Effect, FileSystem, Layer, Option, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/http";

import * as ViewerAuth from "../convex/viewer-auth.ts";
import * as LogsRoutes from "../logging/logs-routes.ts";
import * as RetainedLogs from "../logging/retained-logs.ts";
import * as DiagnosticsRoutes from "./diagnostics-routes.ts";
import { LogEvent } from "./log-events.ts";

const viewer = (id: string, role: Role): Viewer => ({
  user: {
    id: UserId.make(id),
    email: `${id}@example.test`,
    name: id,
    role,
    disabled: false,
    createdAt: EpochMillis.make(0),
  },
  sessionId: AuthSessionId.make(`auth_${id}`),
  sessionKind: "password",
  scopes: roleScopes(role),
});

const VIEWERS: ReadonlyMap<string, Viewer> = new Map([
  ["admin-token", viewer("user_admin", "admin")],
  ["member-token", viewer("user_a", "member")],
  ["other-token", viewer("user_b", "member")],
]);

/** Authorizes the three known tokens with the role scopes, as Convex would. */
const authLayer = Layer.succeed(
  ViewerAuth.Service,
  ViewerAuth.Service.of({
    authorize: (bearer, access) => {
      const found = VIEWERS.get(Redacted.value(bearer));

      if (found === undefined) {
        return Effect.fail(new Unauthenticated({ message: "Unknown token" }));
      }

      return access === "authenticated" || found.scopes.some((scope) => scope === access)
        ? Effect.succeed(found)
        : Effect.fail(new Forbidden({ message: `This session lacks the ${access} scope` }));
    },
  }),
);

const now = Date.now();

const line = (message: string, offsetMs: number, annotations: Readonly<Record<string, string>>) =>
  JSON.stringify({
    message,
    level: "INFO",
    timestamp: new Date(now - 60_000 + offsetMs).toISOString(),
    annotations,
    spans: {},
  });

const SEED = [
  line(LogEvent.streamStarted, 0, {
    sessionId: "session_a",
    userId: "user_a",
    streamId: "s1",
    mode: "remux",
  }),
  line(LogEvent.streamEnded, 1000, {
    sessionId: "session_a",
    userId: "user_a",
    streamId: "s1",
    reason: "idle",
  }),
  line(LogEvent.streamStarted, 2000, { sessionId: "session_b", userId: "user_b", mode: "direct" }),
  line("Main.started", 3000, {}),
];

/** The running routes, and the retained log behind them. */
class Server extends Context.Service<
  Server,
  { readonly baseUrl: string; readonly logs: RetainedLogs.Interface }
>()("test/DiagnosticsServer") {}

const serverLayer = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "movies-diagnostics-" });

    const logs = yield* RetainedLogs.make({
      directory,
      retention: { maxAgeMs: Duration.toMillis(Duration.days(14)), maxBytes: 1 << 29 },
    });

    for (const entry of SEED) logs.append(entry);
    yield* logs.flush;

    const routes = HttpRouter.serve(Layer.mergeAll(LogsRoutes.layer, DiagnosticsRoutes.layer), {
      disableLogger: true,
      disableListenLog: true,
    }).pipe(
      Layer.provide(Layer.mergeAll(authLayer, Layer.succeed(RetainedLogs.Service, logs))),
      Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0, host: "127.0.0.1" })),
    );

    const ready = Layer.effect(
      Server,
      HttpServer.addressFormattedWith((baseUrl) => Effect.succeed(Server.of({ baseUrl, logs }))),
    );

    return ready.pipe(Layer.provideMerge(routes));
  }),
).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)));

/** A request body: a log query or command arguments. */
type Body = Readonly<Record<string, string | number | boolean>>;

/** POSTs `body` to `path` with `token` as the bearer, when there is one. */
const post = (path: string, token: Option.Option<string>, body: Body) =>
  Effect.gen(function* () {
    const { baseUrl } = yield* Server;
    const headers = new Headers({ "content-type": "application/json" });

    if (Option.isSome(token)) headers.set("authorization", `Bearer ${token.value}`);

    return yield* Effect.promise(() =>
      fetch(`${baseUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body) }),
    );
  });

const ADMIN = Option.some("admin-token");

const MEMBER = Option.some("member-token");

const OTHER = Option.some("other-token");

const text = (response: Response) => Effect.promise(() => response.text());

/** A response body decoded as JSON with `schema`. */
const decoded = <A>(schema: Schema.Codec<A, unknown>) => {
  const decode = Schema.decodeUnknownSync(Schema.fromJsonString(schema));

  return (response: Response) => Effect.map(text(response), decode);
};

const failureOf = decoded(Schema.Struct({ code: Schema.String }));

const timelineOf = decoded(Schema.toCodecJson(PlaybackDiagnostics));

const sessionIdsOf = (response: Response) =>
  Effect.map(decoded(Schema.toCodecJson(Schema.Array(DiagnosedSession)))(response), (sessions) =>
    sessions.map((session) => session.sessionId),
  );

const messageOf = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ message: Schema.String })),
);

layer(serverLayer, { timeout: 30_000 })("log and diagnostics routes", (it) => {
  it.effect("serve the retained log to admins as NDJSON", () =>
    Effect.gen(function* () {
      const response = yield* post("/api/logs", ADMIN, {});
      const lines = (yield* text(response)).trim().split("\n");

      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.headers.get("content-type"), "application/x-ndjson");
      assert.strictEqual(response.headers.get("x-movies-log-truncated"), "false");
      assert.deepStrictEqual(lines, SEED);
    }),
  );

  it.effect("refuse the log to members and to callers without a token", () =>
    Effect.gen(function* () {
      const member = yield* post("/api/logs", MEMBER, {});
      const anonymous = yield* post("/api/logs", Option.none(), {});

      assert.strictEqual(member.status, 403);
      assert.strictEqual((yield* failureOf(member)).code, "forbidden");
      assert.strictEqual(anonymous.status, 401);
    }),
  );

  it.effect("reject a query that is not one", () =>
    Effect.gen(function* () {
      const response = yield* post("/api/logs", ADMIN, { limit: 0 });

      assert.strictEqual(response.status, 400);
      assert.strictEqual((yield* failureOf(response)).code, "invalid_args");
    }),
  );

  it.effect("follow the log: new matching records arrive as they are written", () =>
    Effect.gen(function* () {
      const { logs } = yield* Server;

      const response = yield* post("/api/logs", ADMIN, {
        sessionId: "session_a",
        follow: true,
      });

      const body = yield* Effect.fromOption(Option.fromNullishOr(response.body)).pipe(Effect.orDie);
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let received = "";

      logs.append(line(LogEvent.streamStarted, 5000, { sessionId: "session_b", userId: "user_b" }));
      logs.append(line(LogEvent.streamMoved, 6000, { sessionId: "session_a", userId: "user_a" }));
      yield* logs.flush;

      while (!received.includes(LogEvent.streamMoved)) {
        const chunk = yield* Effect.promise(() => reader.read());

        if (chunk.done) break;

        if (chunk.value instanceof Uint8Array) received += decoder.decode(chunk.value);
      }

      yield* Effect.promise(() => reader.cancel());

      const messages = received
        .trim()
        .split("\n")
        .map((entry) => messageOf(entry).message);

      assert.deepStrictEqual(messages, [
        LogEvent.streamStarted,
        LogEvent.streamEnded,
        LogEvent.streamMoved,
      ]);
    }),
  );

  it.effect("give a member the timeline of their own session only", () =>
    Effect.gen(function* () {
      const own = yield* post("/api/diagnostics/playback", MEMBER, {
        sessionId: "session_a",
      });

      const others = yield* post("/api/diagnostics/playback", MEMBER, {
        sessionId: "session_b",
      });

      assert.strictEqual(own.status, 200);
      assert.strictEqual((yield* timelineOf(own)).sessionId, "session_a");
      assert.strictEqual(others.status, 404);
      assert.strictEqual((yield* failureOf(others)).code, "not_found");
    }),
  );

  it.effect("give an admin any session's timeline", () =>
    Effect.gen(function* () {
      const response = yield* post("/api/diagnostics/playback", ADMIN, {
        sessionId: "session_b",
      });

      const timeline = yield* timelineOf(response);

      assert.strictEqual(response.status, 200);
      assert.strictEqual(timeline.sessionId, "session_b");
      assert.strictEqual(timeline.drift.status, "not-measured");
    }),
  );

  it.effect("list a member's own sessions and every session for an admin", () =>
    Effect.gen(function* () {
      const member = yield* sessionIdsOf(yield* post("/api/diagnostics/sessions", OTHER, {}));
      const admin = yield* sessionIdsOf(yield* post("/api/diagnostics/sessions", ADMIN, {}));

      assert.deepStrictEqual(member, ["session_b"]);
      assert.sameMembers(admin, ["session_a", "session_b"]);
    }),
  );
});
