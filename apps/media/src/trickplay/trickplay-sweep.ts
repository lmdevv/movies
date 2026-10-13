/**
 * Keeps the thumbnail folder to what the catalog uses: a minute after startup, then every
 * `LIBRARY_RECONCILE_MINUTES`, thumbnails of removed or missing files and of older contents are
 * deleted (`TrickplayStore.sweep`). A sweep the catalog cannot answer is skipped until the next.
 */
import { Duration, Effect, Layer, Schedule } from "effect";

import * as MediaBackend from "../convex/media-backend.ts";
import * as MediaConfig from "../media-config.ts";
import * as TrickplayStore from "./trickplay-store.ts";

const FIRST_SWEEP_AFTER = Duration.minutes(1);

/** Sweeps for the lifetime of the layer. */
export const layer: Layer.Layer<
  never,
  never,
  MediaBackend.Service | MediaConfig.Service | TrickplayStore.Service
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const backend = yield* MediaBackend.Service;
    const config = yield* MediaConfig.Service;
    const store = yield* TrickplayStore.Service;

    const sweep = store
      .sweep((fileIds) =>
        backend
          .call("mediaService.trickplayVersions", { fileIds })
          .pipe(Effect.map((rows) => new Map(rows.map((row) => [row.fileId, row.version])))),
      )
      .pipe(
        Effect.tap((removed) =>
          removed === 0
            ? Effect.void
            : Effect.logInfo("TrickplaySweep.removed").pipe(Effect.annotateLogs({ removed })),
        ),
        Effect.catch((error) => Effect.logWarning("TrickplaySweep.skipped", error)),
      );

    yield* sweep.pipe(
      Effect.delay(FIRST_SWEEP_AFTER),
      Effect.repeat(Schedule.spaced(config.reconcileInterval)),
      Effect.forkScoped,
    );
  }),
);
