import { assert, describe, it } from "@effect/vitest";
import {
  type ClientDiagnosticEvent,
  type ClientDiagnosticsRequest,
  type LogRecord,
  PlayerObservation,
} from "@movies/contracts/diagnostics";
import { PlaybackSessionId } from "@movies/contracts/ids";
import { StreamId } from "@movies/contracts/media-playback";
import { Effect, Layer, Logger, Option, Predicate, Redacted } from "effect";

import { decodeRecord } from "../logging/log-query.ts";
import * as EndedSessions from "../playback/ended-sessions.ts";
import * as PlaybackToken from "../playback/playback-token.ts";
import * as StreamOwners from "../playback/stream-owners.ts";
import { signTestToken, testConfigLayer } from "../testing/test-config.ts";
import * as ClientDiagnostics from "./client-events.ts";
import { LogEvent } from "./log-events.ts";

const recorderLayer = ClientDiagnostics.layer.pipe(
  Layer.provideMerge(PlaybackToken.layer),
  Layer.provideMerge(EndedSessions.layer),
  Layer.provideMerge(StreamOwners.layer),
  Layer.provide(testConfigLayer({})),
  Layer.orDie,
);

/** Runs `effect` with a fresh recorder, returning what it logged at `INFO` and above. */
const recording = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    ClientDiagnostics.Service | EndedSessions.Service | StreamOwners.Service
  >,
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
  ageMs: 2000,
  observation: PlayerObservation.cases.BufferingEnded.make({
    positionSeconds: 70,
    bufferedAheadSeconds: 0,
    durationMs: 31_000,
    endedBy: "playing",
  }),
};

describe("client diagnostics", () => {
  it.live("logs each event under its player name with the verified session and account", () =>
    Effect.gen(function* () {
      const before = Date.now();

      const { logged } = yield* recording(
        Effect.flatMap(ClientDiagnostics.Service, (recorder) =>
          recorder.record(
            batch([
              {
                ageMs: 5000,
                observation: PlayerObservation.cases.Attached.make({
                  mode: "remux",
                  engine: "hls.js",
                }),
              },
              stall,
              {
                ageMs: 0,
                observation: PlayerObservation.cases.FragmentLoaded.make({
                  segment: 13,
                  durationMs: 90,
                  firstByteMs: 20,
                  bytes: 1000,
                }),
              },
              {
                ageMs: 0,
                observation: PlayerObservation.cases.PlayerError.make({
                  source: "hls.js",
                  kind: "fragLoadError",
                  detail: "HTTP 404 for https://media/x.m4s?token=v1.abc.def",
                  fatal: true,
                  status: 404,
                }),
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

  it.live("files an event under its stream only when the stream is the session's", () =>
    Effect.gen(function* () {
      const own = StreamId.make("AAAAAAAAAAAAAAAAAAAAAA");
      const ended = StreamId.make("BBBBBBBBBBBBBBBBBBBBBB");
      const others = StreamId.make("CCCCCCCCCCCCCCCCCCCCCC");

      const { logged } = yield* recording(
        Effect.gen(function* () {
          const owners = yield* StreamOwners.Service;

          yield* owners.opened(own, PlaybackSessionId.make("session_test"));
          yield* owners.opened(ended, PlaybackSessionId.make("session_test"));
          yield* owners.closed(ended);
          yield* owners.opened(others, PlaybackSessionId.make("session_other"));

          yield* (yield* ClientDiagnostics.Service).record(
            batch(
              [own, ended, others].map((streamId) => ({
                ageMs: stall.ageMs,
                streamId,
                observation: stall.observation,
              })),
            ),
          );
        }),
      );

      assert.deepStrictEqual(
        logged.map((entry) => [
          entry.annotations["streamId"],
          entry.annotations["claimedStreamId"],
        ]),
        [
          [own, null],
          [ended, null],
          [null, others],
        ],
      );
    }),
  );

  it.live("limits an account across its sessions", () =>
    Effect.gen(function* () {
      const hundred = Array.from({ length: 100 }, () => stall);

      const { result, logged } = yield* recording(
        Effect.gen(function* () {
          const recorder = yield* ClientDiagnostics.Service;

          for (const session of ["one", "one", "two", "two"]) {
            yield* recorder.record(batch(hundred, session));
          }

          return yield* recorder.record(batch(hundred, "three")).pipe(Effect.flip);
        }),
      );

      assert.isTrue(Predicate.isTagged(result, "DiagnosticsRateLimited"));
      assert.strictEqual(logged.length, 400);
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
