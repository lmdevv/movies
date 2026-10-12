/**
 * Media service entrypoint. Reads configuration, serves HTTP, and keeps libraries in sync.
 *
 * With `CONVEX_URL` and `MEDIA_SERVICE_API_KEY` the service signs in to Convex: libraries, files,
 * and jobs come from Convex, scans write back to it, and playback resolves files through it.
 * Without `CONVEX_URL` it runs standalone for development and tests: each `LIBRARY_ROOTS` entry is
 * scanned into memory and playback events are logged.
 *
 * Routes are assembled in `http/http-server.ts` (one layer per route group). Job kinds are
 * registered in `jobHandlers` below.
 */
import { createHash } from "node:crypto";

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { LibraryId } from "@movies/contracts/ids";
import { Effect, Layer, Option, Schema } from "effect";
import { FetchHttpClient } from "effect/http";

import * as ArtworkKeys from "./artwork/artwork-keys.ts";
import * as BackendHealth from "./backend-health.ts";
import * as ConvexFileResolver from "./convex/convex-file-resolver.ts";
import * as ConvexLibrarySink from "./convex/convex-library-sink.ts";
import * as ConvexPlaybackReporter from "./convex/convex-playback-reporter.ts";
import * as EndedSessionWatcher from "./convex/ended-session-watcher.ts";
import * as LibrarySync from "./convex/library-sync.ts";
import * as MediaBackend from "./convex/media-backend.ts";
import * as ViewerAuth from "./convex/viewer-auth.ts";
import * as HttpServer from "./http/http-server.ts";
import * as MetadataRoutes from "./http/metadata-routes.ts";
import * as JobWorker from "./jobs/job-worker.ts";
import * as MetadataJob from "./jobs/metadata-job.ts";
import * as ScanJob from "./jobs/scan-job.ts";
import * as LibraryMonitor from "./library/library-monitor.ts";
import * as MemoryLibrary from "./library/memory-library.ts";
import * as MediaConfig from "./media-config.ts";
import { servicesLayer } from "./media-service.ts";
import * as Observability from "./observability.ts";
import * as PlaybackReporter from "./playback/playback-reporter.ts";

/** `CONVEX_URL` is set without `MEDIA_SERVICE_API_KEY`, so the service cannot sign in. */
class MediaServiceKeyMissing extends Schema.TaggedError<MediaServiceKeyMissing>()(
  "MediaServiceKeyMissing",
  {},
) {
  override get message(): string {
    return "Media service key missing: CONVEX_URL is set but MEDIA_SERVICE_API_KEY is not; run packages/backend/scripts/configure.ts";
  }
}

/** The job kinds this service runs. Add a kind's handler here. */
const jobHandlers = Effect.all([ScanJob.handler, MetadataJob.handler]);

/** Route groups of registry `media` commands. Add a group's layer here. */
const commandRoutes = Layer.mergeAll(MetadataRoutes.layer);

/** Signed in to Convex: Convex libraries, scan jobs, ended sessions, and file records. */
const convexMode = (options: MediaBackend.Options) =>
  Layer.mergeAll(
    HttpServer.layer(commandRoutes),
    JobWorker.layer(jobHandlers),
    LibrarySync.layer,
    EndedSessionWatcher.layer,
  ).pipe(
    Layer.provide(LibraryMonitor.layer()),
    Layer.provide(servicesLayer),
    Layer.provide(
      Layer.mergeAll(
        ConvexLibrarySink.layer,
        ConvexFileResolver.layer,
        ConvexPlaybackReporter.layer,
      ),
    ),
    Layer.provide(ArtworkKeys.layer),
    Layer.provide(ViewerAuth.layer(options.convexUrl)),
    Layer.provideMerge(MediaBackend.layer(options)),
  );

/** Standalone: one in-memory library per approved root, kept in sync by the monitor. */
const standaloneMode = (roots: ReadonlyArray<string>) =>
  Layer.mergeAll(
    HttpServer.layer(Layer.empty),
    LibraryMonitor.layerTracking(
      roots.map((root) => ({
        libraryId: LibraryId.make(
          `root-${createHash("sha256").update(root).digest("hex").slice(0, 12)}`,
        ),
        roots: [root],
      })),
    ),
  ).pipe(
    Layer.provide(LibraryMonitor.layer()),
    Layer.provide(servicesLayer),
    Layer.provide(
      Layer.mergeAll(MemoryLibrary.layer, PlaybackReporter.layerLog, BackendHealth.layerStandalone),
    ),
  );

const application = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* MediaConfig.Service;

    if (Option.isNone(config.convexUrl)) {
      yield* Effect.logInfo("Main.standalone_mode");

      return standaloneMode(config.libraryRoots);
    }

    if (Option.isNone(config.mediaServiceApiKey)) return yield* new MediaServiceKeyMissing();

    return convexMode({
      convexUrl: config.convexUrl.value,
      apiKey: config.mediaServiceApiKey.value,
    });
  }),
).pipe(
  Layer.provide(Observability.layer),
  Layer.provide(MediaConfig.layer),
  Layer.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
);

Layer.launch(application).pipe(NodeRuntime.runMain);
