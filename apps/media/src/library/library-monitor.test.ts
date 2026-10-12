import { NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import { Context, Duration, Effect, FileSystem, Layer, Option, Path, Schedule } from "effect";
import { FetchHttpClient } from "effect/http";

import * as DiskCache from "../disk-cache.ts";
import { LibraryId } from "@movies/contracts/ids";
import * as MediaTools from "../media/media-tools.ts";
import * as MetadataResolver from "../metadata/title-metadata.ts";
import * as Tmdb from "../metadata/tmdb.ts";
import { ffmpegAvailable } from "../testing/fixture-library.ts";
import * as FixtureWorkspace from "../testing/fixture-workspace.ts";
import { testConfigLayer } from "../testing/test-config.ts";
import * as LibraryMonitor from "./library-monitor.ts";
import * as LibraryScanner from "./library-scanner.ts";
import * as MemoryLibrary from "./memory-library.ts";

const hasFfmpeg = await ffmpegAvailable();

const libraryId = LibraryId.make("watched");

class Watched extends Context.Service<Watched, { readonly root: string }>()(
  "test/WatchedLibrary",
) {}

const monitorLayer = Layer.unwrap(
  Effect.gen(function* () {
    const workspace = yield* FixtureWorkspace.Service;
    const path = yield* Path.Path;
    const copy = yield* workspace.copy.pipe(Effect.orDie);

    const config = testConfigLayer({
      LIBRARY_ROOTS: workspace.root,
      DATA_DIR: path.join(workspace.root, "data"),
      LIBRARY_RECONCILE_MINUTES: "600",
    });

    const scanner = LibraryScanner.layer.pipe(
      Layer.provideMerge(MemoryLibrary.layer),
      Layer.provide(MetadataResolver.layer),
      Layer.provide(Tmdb.layerWithOptions(Tmdb.defaultOptions(Option.none()))),
      Layer.provide(DiskCache.layer),
      Layer.provide(MediaTools.layer),
    );

    const monitor = LibraryMonitor.layerTracking([{ libraryId, roots: [copy.movies] }]).pipe(
      Layer.provideMerge(LibraryMonitor.layer(Duration.millis(200))),
    );

    return monitor.pipe(
      Layer.merge(Layer.succeed(Watched, Watched.of({ root: copy.movies }))),
      Layer.provideMerge(scanner),
      Layer.provideMerge(config),
    );
  }),
).pipe(
  Layer.provideMerge(FixtureWorkspace.layer),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
);

/** Polls the store until `check` holds, for up to fifteen seconds. */
const eventually = (check: (files: ReadonlyMap<string, MemoryLibrary.StoredFile>) => boolean) =>
  Effect.gen(function* () {
    const library = yield* MemoryLibrary.Service;

    const files = new Map(
      (yield* library.files(libraryId)).map((file) => [file.record.relativePath, file]),
    );

    return check(files) ? Option.some(files) : Option.none();
  }).pipe(
    Effect.repeat({ until: Option.isSome, schedule: Schedule.spaced("100 millis") }),
    Effect.timeout("15 seconds"),
    Effect.orDie,
  );

describe.skipIf(!hasFfmpeg)("LibraryMonitor", () => {
  layer(monitorLayer, { excludeTestServices: true, timeout: "60 seconds" })((it) => {
    it.effect(
      "scans at startup and rescans after file changes",
      () =>
        Effect.gen(function* () {
          const { library } = yield* FixtureWorkspace.Service;
          const { root } = yield* Watched;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;

          yield* eventually((files) => files.size === 4);
          yield* fs.makeDirectory(path.join(root, "New Movie (2024)"));
          yield* fs.copyFile(
            path.join(root, library.messyMovie),
            path.join(root, "New Movie (2024)", "New Movie (2024).mkv"),
          );

          const added = yield* eventually((files) =>
            files.has("New Movie (2024)/New Movie (2024).mkv"),
          );

          assert.strictEqual(
            Option.getOrUndefined(added)?.get("New Movie (2024)/New Movie (2024).mkv")?.record.title
              ?.title,
            "New Movie",
          );

          yield* fs.remove(path.join(root, library.messyMovie));
          yield* eventually((files) => files.get(library.messyMovie)?.missing === true);
        }),
      // Each step may wait up to 15 seconds for the watcher; the default 5 second budget is
      // shorter than one step under load.
      60_000,
    );
  });
});
