/**
 * The diagnostics commands the media service serves, from its retained log:
 * `diagnostics.playback` (`POST /api/diagnostics/playback`), one session's timeline, and
 * `diagnostics.sessions` (`POST /api/diagnostics/sessions`), the sessions the log mentions. A
 * session holding the `admin` scope reads every session; any other reads only sessions whose
 * records all name its own account, and another account's session is `NotFound`, as if it did
 * not exist.
 */
import { MAX_LOG_LIMIT } from "@movies/contracts/diagnostics";
import { NotFound } from "@movies/contracts/errors";
import { EpochMillis } from "@movies/contracts/units";
import type { Viewer } from "@movies/contracts/models/account";
import { Clock, Duration, Effect, FileSystem, Layer, Option, Path } from "effect";
import type { HttpRouter } from "effect/http";

import type * as ViewerAuth from "../convex/viewer-auth.ts";
import { commandRoute } from "../http/command-routes.ts";
import * as LogReader from "../logging/log-reader.ts";
import * as RetainedLogs from "../logging/retained-logs.ts";
import { ownersOf, sessionsOf, timelineOf } from "./timeline.ts";

/** How far back `diagnostics.sessions` looks without `since`. */
const RECENT = Duration.days(1);

/** The most sessions `diagnostics.sessions` lists. */
const MAX_SESSIONS = 50;

const isAdmin = (viewer: Viewer): boolean => viewer.scopes.includes("admin");

/** Adds the routes. */
export const layer: Layer.Layer<
  never,
  never,
  | HttpRouter.HttpRouter
  | ViewerAuth.Service
  | RetainedLogs.Service
  | FileSystem.FileSystem
  | Path.Path
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const retained = yield* RetainedLogs.Service;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const read = (query: Parameters<typeof LogReader.read>[0]) =>
      LogReader.read(query).pipe(
        Effect.scoped,
        Effect.provideService(RetainedLogs.Service, retained),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );

    yield* commandRoute(
      "diagnostics.playback",
      Effect.fn("DiagnosticsRoutes.playback")(function* ({ sessionId }, viewer) {
        const found = yield* read({ sessionId, limit: MAX_LOG_LIMIT });
        const records = found.matches.map((match) => match.record);
        const owners = ownersOf(records);

        const allowed =
          isAdmin(viewer) || (owners.size > 0 && [...owners].every((id) => id === viewer.user.id));

        const timeline = allowed ? timelineOf(sessionId, records, found.truncated) : Option.none();

        if (Option.isNone(timeline)) {
          return yield* new NotFound({
            message: `No playback records for session ${sessionId} in the retained logs`,
          });
        }

        return timeline.value;
      }),
    );

    yield* commandRoute(
      "diagnostics.sessions",
      Effect.fn("DiagnosticsRoutes.sessions")(function* ({ since }, viewer) {
        const now = yield* Clock.currentTimeMillis;

        const found = yield* read({
          since: since ?? EpochMillis.make(Math.max(0, now - Duration.toMillis(RECENT))),
          grep: '"sessionId"',
          limit: MAX_LOG_LIMIT,
        });

        return sessionsOf(found.matches.map((match) => match.record))
          .filter((session) => isAdmin(viewer) || session.userId === viewer.user.id)
          .slice(0, MAX_SESSIONS);
      }),
    );
  }),
);
