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
