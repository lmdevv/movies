/**
 * Media service entrypoint. Reads configuration, serves HTTP, and keeps the approved library
 * roots in sync. Until the Convex integration lands, library records live in memory
 * (standalone mode) and playback events are logged.
 */
import { createHash } from "node:crypto";

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Layer, Option } from "effect";
import { FetchHttpClient } from "effect/http";

import * as BackendHealth from "./backend-health.ts";
import * as HttpServer from "./http/http-server.ts";
import { LibraryId } from "@movies/contracts/ids";
import * as LibraryMonitor from "./library/library-monitor.ts";
import * as MemoryLibrary from "./library/memory-library.ts";
import * as MediaConfig from "./media-config.ts";
import { servicesLayer } from "./media-service.ts";
import * as Observability from "./observability.ts";
import * as PlaybackReporter from "./playback/playback-reporter.ts";

/** One in-memory library per approved root, kept in sync by the monitor. */
const standaloneLibraries = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* MediaConfig.Service;
    const library = yield* MemoryLibrary.Service;

    if (Option.isSome(config.convexUrl)) {
      yield* Effect.logWarning("Main.standalone_mode").pipe(
        Effect.annotateLogs({
          detail: "CONVEX_URL is set but the Convex integration is not wired yet",
        }),
      );
    }

    const libraries = config.libraryRoots.map((root) => ({
      libraryId: LibraryId.make(
        `root-${createHash("sha256").update(root).digest("hex").slice(0, 12)}`,
      ),
      root,
    }));

    yield* Effect.forEach(libraries, (entry) => library.addLibrary(entry.libraryId, entry.root), {
      discard: true,
    });

    return LibraryMonitor.layer(libraries);
  }),
);

const application = Layer.mergeAll(HttpServer.layer, standaloneLibraries).pipe(
  Layer.provide(servicesLayer),
  Layer.provide(
    Layer.mergeAll(MemoryLibrary.layer, PlaybackReporter.layerLog, BackendHealth.layerStandalone),
  ),
  Layer.provide(Observability.layer),
  Layer.provide(MediaConfig.layer),
  Layer.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
);

Layer.launch(application).pipe(NodeRuntime.runMain);
