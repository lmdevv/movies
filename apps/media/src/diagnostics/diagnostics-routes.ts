/**
 * The diagnostics commands the media service serves, from its retained log:
 * `diagnostics.playback` (`POST /api/diagnostics/playback`), one session's timeline, and
 * `diagnostics.sessions` (`POST /api/diagnostics/sessions`), the sessions the log mentions. A
 * session holding the `admin` scope reads every session; any other reads only sessions whose
 * records all name its own account, and another account's session is `NotFound`, as if it did
 * not exist. Both read at `INFO` and above, where every playback event is, so `DEBUG` records never
 * crowd a session's events out of the read limit. A read can scan the whole retained log, so an
 * account without the `admin` scope may read a few times a minute; admins, who may read the log
 * itself, are not limited.
 */
import { type LogQuery, MAX_LOG_LIMIT } from "@movies/contracts/diagnostics";
import { NotFound, RateLimited } from "@movies/contracts/errors";
import { EpochMillis } from "@movies/contracts/units";
import type { Viewer } from "@movies/contracts/models/account";
import { Clock, Duration, Effect, FileSystem, Layer, Option, Path, References } from "effect";
import type { HttpRouter } from "effect/http";

import type * as ViewerAuth from "../convex/viewer-auth.ts";
import { commandRoute } from "../http/command-routes.ts";
import { makeLimiter } from "../http/rate-limit.ts";
import * as LogReader from "../logging/log-reader.ts";
import * as RetainedLogs from "../logging/retained-logs.ts";
import { ownersOf, sessionsOf, timelineOf } from "./timeline.ts";

/** How far back `diagnostics.sessions` looks without `since`. */
const RECENT = Duration.days(1);

/** The most sessions `diagnostics.sessions` lists. */
const MAX_SESSIONS = 50;

/** Reads one account may make at once, and how many more each second after that. */
const READ_BUDGET = { burst: 10, perSecond: 0.2 };

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

    const take = makeLimiter();

    const allowRead = (viewer: Viewer) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) =>
          Option.match(isAdmin(viewer) ? Option.none() : take(viewer.user.id, READ_BUDGET, now), {
            onNone: () => Effect.void,
            onSome: (seconds) =>
              Effect.fail(
                new RateLimited({
                  message: `Too many diagnostics reads: try again in ${String(seconds)} s`,
                }),
              ),
          }),
        ),
      );

    const read = (filter: Pick<LogQuery, "sessionId" | "since" | "grep">) =>
      LogReader.read({
        sessionId: filter.sessionId,
        since: filter.since,
        grep: filter.grep,
        level: "INFO",
        limit: MAX_LOG_LIMIT,
      }).pipe(
        Effect.scoped,
        Effect.provideService(RetainedLogs.Service, retained),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );

    yield* commandRoute(
      "diagnostics.playback",
      Effect.fn("DiagnosticsRoutes.playback")(function* ({ sessionId }, viewer) {
        yield* allowRead(viewer);
        const found = yield* read({ sessionId });
        const records = found.matches.map((match) => match.record);
        const owners = ownersOf(records);

        const allowed =
          isAdmin(viewer) || (owners.size > 0 && [...owners].every((id) => id === viewer.user.id));

        const logLevel = yield* References.MinimumLogLevel;

        const timeline = allowed
          ? timelineOf(sessionId, records, found.truncated, logLevel)
          : Option.none();

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
        yield* allowRead(viewer);
        const now = yield* Clock.currentTimeMillis;

        // A member's records all carry its account ID, so other accounts' traffic is skipped.
        const found = yield* read({
          since: since ?? EpochMillis.make(Math.max(0, now - Duration.toMillis(RECENT))),
          grep: isAdmin(viewer) ? '"sessionId"' : viewer.user.id,
        });

        return sessionsOf(found.matches.map((match) => match.record))
          .filter((session) => isAdmin(viewer) || session.userId === viewer.user.id)
          .slice(0, MAX_SESSIONS);
      }),
    );
  }),
);
