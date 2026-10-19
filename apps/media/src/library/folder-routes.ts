/**
 * The folder browser the media service serves: `libraries.folders` (`POST /api/libraries/folders`)
 * lists the media host's folders inside the approved library roots for a session holding the
 * `manage` scope, so an admin can choose a library's folder instead of typing it.
 */
import { Layer, Effect } from "effect";
import type { FileSystem, Path } from "effect";
import type { HttpRouter } from "effect/http";

import type * as ViewerAuth from "../convex/viewer-auth.ts";
import { commandRoute } from "../http/command-routes.ts";
import type * as MediaConfig from "../media-config.ts";
import * as ServerFolders from "./server-folders.ts";

/** Adds the folder browser route. */
export const layer: Layer.Layer<
  never,
  never,
  | HttpRouter.HttpRouter
  | ViewerAuth.Service
  | MediaConfig.Service
  | FileSystem.FileSystem
  | Path.Path
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const context = yield* Effect.context<
      MediaConfig.Service | FileSystem.FileSystem | Path.Path
    >();

    yield* commandRoute("libraries.folders", ({ path }) =>
      ServerFolders.list(path).pipe(Effect.provideContext(context)),
    );
  }),
);
