import { NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import { Context, Duration, Effect, FileSystem, Layer, Option, Path, Schedule } from "effect";
import { FetchHttpClient } from "effect/http";
import { test } from "vitest";

import * as DiskCache from "../disk-cache.ts";
import { LibraryId } from "@movies/contracts/ids";
import * as MediaTools from "../media/media-tools.ts";
import * as MetadataResolver from "../metadata/title-metadata.ts";
import * as Omdb from "../metadata/omdb.ts";
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

/** The monitor over a fresh copy of the fixture movies, with extra environment `overrides`. */
const monitorLayer = (overrides: Readonly<Record<string, string>> = {}) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const workspace = yield* FixtureWorkspace.Service;
      const path = yield* Path.Path;
      const copy = yield* workspace.copy.pipe(Effect.orDie);

      const config = testConfigLayer({
        LIBRARY_ROOTS: workspace.root,
        DATA_DIR: path.join(workspace.root, "data"),
        LIBRARY_RECONCILE_MINUTES: "600",
        ...overrides,
      });

      const scanner = LibraryScanner.layer.pipe(
        Layer.provideMerge(MemoryLibrary.layer),
        Layer.provide(MetadataResolver.layer),
        Layer.provide(Tmdb.layerWithOptions(Tmdb.defaultOptions(Option.none()))),
        Layer.provide(Omdb.layerWithOptions(Omdb.defaultOptions(Option.none()))),
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
  layer(monitorLayer({ LIBRARY_WATCH: "events" }), {
    excludeTestServices: true,
    timeout: "60 seconds",
  })((it) => {
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

    it.effect(
      "starts watching again after the library folder goes away and comes back",
      () =>
        Effect.gen(function* () {
          const { root } = yield* Watched;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const parked = `${root}.parked`;

          yield* eventually((files) => files.has("New Movie (2024)/New Movie (2024).mkv"));

          // An unmounted share: the watched folder disappears, then a new one with a new film
          // appears in its place.
          yield* fs.copy(root, parked);
          yield* fs.remove(root, { recursive: true });
          yield* Effect.sleep(Duration.millis(500));
          yield* fs.makeDirectory(path.join(parked, "Returned (2025)"));
          yield* fs.copyFile(
            path.join(parked, "New Movie (2024)", "New Movie (2024).mkv"),
            path.join(parked, "Returned (2025)", "Returned (2025).mkv"),
          );
          yield* fs.rename(parked, root);

          yield* eventually((files) => files.has("Returned (2025)/Returned (2025).mkv"));
        }),
      60_000,
    );
  });

  layer(monitorLayer({ LIBRARY_WATCH: "poll", LIBRARY_POLL_SECONDS: "1" }), {
    excludeTestServices: true,
    timeout: "60 seconds",
  })((it) => {
    it.effect(
      "polls a library that sends no file events",
      () =>
        Effect.gen(function* () {
          const { library } = yield* FixtureWorkspace.Service;
          const { root } = yield* Watched;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;

          yield* eventually((files) => files.size === 4);
          yield* fs.makeDirectory(path.join(root, "Polled (2023)"));
          yield* fs.copyFile(
            path.join(root, library.messyMovie),
            path.join(root, "Polled (2023)", "Polled (2023).mkv"),
          );

          yield* eventually((files) => files.has("Polled (2023)/Polled (2023).mkv"));
        }),
      60_000,
    );
  });
});

describe("watch restarts", () => {
  test("back off while a watch keeps failing, and start over after one that ran well", () => {
    const delays: Array<number> = [];
    let failures = 0;

    // Six quick failures back off to 32 s; then a watch that ran for an hour fails.
    for (const ranMillis of [10, 10, 10, 10, 10, 10, 3_600_000, 10]) {
      failures = LibraryMonitor.failuresAfter(failures, ranMillis);
      delays.push(Duration.toSeconds(LibraryMonitor.restartDelay(failures)));
    }

    assert.deepStrictEqual(delays, [1, 2, 4, 8, 16, 32, 1, 2]);
    assert.strictEqual(Duration.toMinutes(LibraryMonitor.restartDelay(40)), 5);
  });
});
