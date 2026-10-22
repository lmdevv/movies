import { Effect, Layer, Stream } from "effect";

import * as LibraryMonitor from "../library/library-monitor.ts";
import * as MediaBackend from "./media-backend.ts";

/** Follows `mediaService:libraries` for the lifetime of the layer. */
export const layer: Layer.Layer<never, never, MediaBackend.Service | LibraryMonitor.Service> =
  Layer.effectDiscard(
    Effect.gen(function* () {
      const backend = yield* MediaBackend.Service;
      const monitor = yield* LibraryMonitor.Service;

      yield* backend.subscribe("mediaService.libraries", {}).pipe(
        Stream.runForEach((libraries) =>
          monitor.track(
            libraries.map((library) => ({ libraryId: library.id, roots: library.roots })),
          ),
        ),
        Effect.forkScoped,
      );
    }),
  );
