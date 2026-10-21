/**
 * The real media service on an ephemeral port for end-to-end tests: fixture library, in-memory
 * store (scanned at startup), recording playback reporter, and the production routes and
 * services. Configuration goes through the real environment decoding, `LOG_LEVEL` included, and
 * every log entry at that level and above is kept for the test to read.
 */
import { createServer } from "node:http";

import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { Context, Effect, Layer, Logger, Option, Path, References } from "effect";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/http";

import * as BackendHealth from "../backend-health.ts";
import { routesLayer, tokenSafeTracing } from "../http/http-server.ts";
import type { LogRecord } from "@movies/contracts/diagnostics";
import { type MediaFileId, LibraryId } from "@movies/contracts/ids";
import * as LibraryScanner from "../library/library-scanner.ts";
import { decodeRecord } from "../logging/log-query.ts";
import * as MemoryLibrary from "../library/memory-library.ts";
import * as MediaConfig from "../media-config.ts";
import { servicesLayer } from "../media-service.ts";
import * as PlaybackReporter from "../playback/playback-reporter.ts";
import * as FixtureWorkspace from "./fixture-workspace.ts";
import { testConfigLayer } from "./test-config.ts";

/** Where the test server listens and how to find fixture files in its store. */
export interface Interface {
  /** Every log entry so far, oldest first. */
  readonly logged: () => ReadonlyArray<LogRecord>;
  /** Base URL of the running server, such as `http://127.0.0.1:41234`. */
  readonly baseUrl: string;
  readonly transcodeDir: string;
  readonly fileId: (library: "movies" | "shows", relativePath: string) => MediaFileId;
}

/** The running test server. */
export class Service extends Context.Service<Service, Interface>()(
  "@movies/media/test/MediaTestServer",
) {}

const MOVIES = LibraryId.make("movies");

const SHOWS = LibraryId.make("shows");

/**
 * Builds the server with extra environment `overrides` (for example `STREAM_IDLE_SECONDS`).
 * The fixture workspace is approved as the only library root.
 */
export const layer = (overrides: Readonly<Record<string, string>> = {}) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const workspace = yield* FixtureWorkspace.Service;
      const path = yield* Path.Path;
      const transcodeDir = path.join(workspace.root, "transcode");

      const config = testConfigLayer({
        LIBRARY_ROOTS: workspace.root,
        DATA_DIR: path.join(workspace.root, "data"),
        TRANSCODE_DIR: transcodeDir,
        MEDIA_BASE_URL: "http://media.test",
        MIN_FREE_TRANSCODE_MB: "1",
        ...overrides,
      });

      const logged: Array<LogRecord> = [];

      // Each entry as the retained log would read it back.
      const logging = Layer.mergeAll(
        Logger.layer(
          [
            Logger.map(Logger.formatJson, (line) => {
              logged.push(...Option.toArray(decodeRecord(line)));
            }),
          ],
          { mergeWithExisting: true },
        ),
        Layer.effect(
          References.MinimumLogLevel,
          Effect.map(MediaConfig.Service, (settings) => settings.logs.level),
        ).pipe(Layer.provide(config)),
      );

      const services = servicesLayer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            MemoryLibrary.layer,
            PlaybackReporter.layerRecording,
            BackendHealth.layerStandalone,
          ),
        ),
        Layer.provideMerge(config),
      );

      const server = HttpRouter.serve(routesLayer, {
        disableLogger: true,
        disableListenLog: true,
      }).pipe(
        Layer.provide(tokenSafeTracing),
        Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0, host: "127.0.0.1" })),
      );

      const ready = Layer.effect(
        Service,
        Effect.gen(function* () {
          const scanner = yield* LibraryScanner.Service;

          for (const [libraryId, root] of [
            [MOVIES, workspace.library.moviesRoot],
            [SHOWS, workspace.library.showsRoot],
          ] as const) {
            yield* scanner.scan({ libraryId, root, mode: "incremental" }).pipe(Effect.orDie);
          }

          return yield* HttpServer.addressFormattedWith((baseUrl) =>
            Effect.succeed(
              Service.of({
                logged: () => logged,
                baseUrl,
                transcodeDir,
                fileId: (name, relativePath) =>
                  MemoryLibrary.fileIdOf(name === "movies" ? MOVIES : SHOWS, relativePath),
              }),
            ),
          );
        }),
      );

      return ready.pipe(
        Layer.provideMerge(server),
        Layer.provideMerge(services),
        Layer.provide(logging),
      );
    }),
  ).pipe(
    Layer.provideMerge(FixtureWorkspace.layer),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
  );
