import { assert, describe, it } from "@effect/vitest";
import type {
  ClientDiagnosticEvent,
  ClientDiagnosticsRequest,
  LogRecord,
} from "@movies/contracts/diagnostics";
import { PlaybackSessionId } from "@movies/contracts/ids";
import { Effect, Layer, Logger, Option, Predicate, Redacted } from "effect";

import { decodeRecord } from "../logging/log-query.ts";
import * as EndedSessions from "../playback/ended-sessions.ts";
import * as PlaybackToken from "../playback/playback-token.ts";
import { signTestToken, testConfigLayer } from "../testing/test-config.ts";
import * as ClientDiagnostics from "./client-events.ts";
import { LogEvent } from "./log-events.ts";

const recorderLayer = ClientDiagnostics.layer.pipe(
  Layer.provideMerge(PlaybackToken.layer),
  Layer.provideMerge(EndedSessions.layer),
  Layer.provide(testConfigLayer({})),
  Layer.orDie,
);

/** Runs `effect` with a fresh recorder, returning what it logged at `INFO` and above. */
const recording = <A, E>(
  effect: Effect.Effect<A, E, ClientDiagnostics.Service | EndedSessions.Service>,
) =>
  Effect.gen(function* () {
    const logged: Array<LogRecord> = [];

    const capture = Logger.map(Logger.formatJson, (line) => {
      logged.push(...Option.toArray(decodeRecord(line)));
    });

    const context = yield* Layer.build(Layer.merge(recorderLayer, Logger.layer([capture])));
    const result = yield* effect.pipe(Effect.provideContext(context));

    return { result, logged };
  }).pipe(Effect.scoped);

const batch = (
  events: ReadonlyArray<ClientDiagnosticEvent>,
  sid = "session_test",
): ClientDiagnosticsRequest => ({
  token: Redacted.make(signTestToken({ fid: "file_1", sid })),
  platform: "web",
  events,
});

const stall: ClientDiagnosticEvent = {
  _tag: "BufferingEnded",
  ageMs: 2000,
  positionSeconds: 70,
  bufferedAheadSeconds: 0,
  durationMs: 31_000,
  endedBy: "playing",
};

describe("client diagnostics", () => {
  it.live("logs each event under its player name with the verified session and account", () =>
    Effect.gen(function* () {
      const before = Date.now();

      const { logged } = yield* recording(
        Effect.flatMap(ClientDiagnostics.Service, (recorder) =>
          recorder.record(
            batch([
              { _tag: "Attached", ageMs: 5000, mode: "remux", engine: "hls.js" },
              stall,
              {
                _tag: "FragmentLoaded",
                ageMs: 0,
                segment: 13,
                durationMs: 90,
                firstByteMs: 20,
                bytes: 1000,
              },
              {
                _tag: "PlayerError",
                ageMs: 0,
                source: "hls.js",
                kind: "fragLoadError",
                detail: "HTTP 404 for https://media/x.m4s?token=v1.abc.def",
                fatal: true,
                status: 404,
              },
            ]),
          ),
        ),
      );

      assert.deepStrictEqual(
        logged.map((entry) => [entry.message, entry.level]),
        [
          [LogEvent.playerAttached, "INFO"],
          [LogEvent.bufferingEnded, "WARN"],
          [LogEvent.playerError, "ERROR"],
        ],
      );

      const ended = logged[1]?.annotations ?? {};

      assert.deepInclude(ended, {
        sessionId: "session_test",
        userId: "user_test",
        platform: "web",
        source: "player",
        stalledMs: 31_000,
      });

      const reported = ended["occurredAt"];
      const occurred = Predicate.isString(reported) ? Date.parse(reported) : Number.NaN;

      assert.isAtLeast(occurred, before - 2000);
      assert.isAtMost(occurred, Date.now() - 2000);
    }),
  );

  it.live("takes the last events of a session that has already ended", () =>
    Effect.gen(function* () {
      const { logged } = yield* recording(
        Effect.gen(function* () {
          const ended = yield* EndedSessions.Service;

          yield* ended.record([
            { sessionId: PlaybackSessionId.make("session_test"), endedAt: Date.now() },
          ]);
          yield* (yield* ClientDiagnostics.Service).record(batch([stall]));
        }),
      );

      assert.strictEqual(logged.length, 1);
    }),
  );

  it.live("refuses a token it did not sign", () =>
    Effect.gen(function* () {
      const { result } = yield* recording(
        Effect.flatMap(ClientDiagnostics.Service, (recorder) =>
          recorder
            .record({
              token: Redacted.make("v1.forged.token"),
              platform: "web",
              events: [stall],
            })
            .pipe(Effect.flip),
        ),
      );

      assert.isTrue(Predicate.isTagged(result, "PlaybackTokenInvalid"));
    }),
  );

  it.live("limits each session to its budget, and only that session", () =>
    Effect.gen(function* () {
      const hundred = Array.from({ length: 100 }, () => stall);

      const { result } = yield* recording(
        Effect.gen(function* () {
          const recorder = yield* ClientDiagnostics.Service;

          for (let sent = 0; sent < 3; sent += 1) yield* recorder.record(batch(hundred));

          const refused = yield* recorder.record(batch(hundred)).pipe(Effect.flip);

          yield* recorder.record(batch([stall], "session_other"));

          return refused;
        }),
      );

      assert.isTrue(Predicate.isTagged(result, "DiagnosticsRateLimited"));
    }),
  );
});
