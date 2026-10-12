/**
 * Migration commands the media service serves: `migration.connect` (`POST
 * /api/migration/connect`), `migration.dryRun` (`POST /api/migration/dry-run`), and
 * `migration.import` (`POST /api/migration/import`), each for a session holding the `admin` scope.
 * Bodies carry source credentials; `commandRoute` never logs a body.
 */
import { Effect, Layer } from "effect";
import type { HttpRouter } from "effect/http";

import type * as ViewerAuth from "../convex/viewer-auth.ts";
import { commandRoute } from "../http/command-routes.ts";
import * as Migrations from "./migrations.ts";

/** Adds the migration command routes. */
export const layer: Layer.Layer<
  never,
  never,
  HttpRouter.HttpRouter | ViewerAuth.Service | Migrations.Service
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const migrations = yield* Migrations.Service;

    yield* commandRoute("migration.connect", migrations.connect);
    yield* commandRoute("migration.dryRun", migrations.dryRun);
    yield* commandRoute("migration.import", migrations.startImport);
  }),
);
