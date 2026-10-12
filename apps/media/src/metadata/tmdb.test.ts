import { createServer } from "node:http";

import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import { Context, Duration, Effect, FileSystem, Layer, Option, Redacted, Ref } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import { testConfigLayer } from "../testing/test-config.ts";
import * as MetadataCache from "./metadata-cache.ts";
import { guardHosts } from "./metadata-plugin.ts";
import * as MetadataPlugin from "./metadata-plugin.ts";
import * as MetadataResolver from "./title-metadata.ts";
import * as Tmdb from "./tmdb.ts";
import findImdb from "./tmdb-fixtures/find-tt1254207.json" with { type: "json" };
import bigBuckBunny from "./tmdb-fixtures/movie-10378.json" with { type: "json" };
import remuxFixture from "./tmdb-fixtures/movie-500001.json" with { type: "json" };
import searchMovie from "./tmdb-fixtures/search-movie.json" with { type: "json" };
import searchTv from "./tmdb-fixtures/search-tv.json" with { type: "json" };
import seasonOne from "./tmdb-fixtures/tv-99999-season-1.json" with { type: "json" };
import show from "./tmdb-fixtures/tv-99999.json" with { type: "json" };

const API_KEY = "0123456789abcdef0123456789abcdef";

const READ_TOKEN = "eyJhbGciOiJIUzI1NiJ9.test-read-token";

const FIXTURES: ReadonlyMap<string, string> = new Map([
  ["/3/search/movie", JSON.stringify(searchMovie)],
  ["/3/movie/500001", JSON.stringify(remuxFixture)],
  ["/3/movie/10378", JSON.stringify(bigBuckBunny)],
  ["/3/find/tt1254207", JSON.stringify(findImdb)],
  ["/3/search/tv", JSON.stringify(searchTv)],
  ["/3/tv/99999", JSON.stringify(show)],
  ["/3/tv/99999/season/1", JSON.stringify(seasonOne)],
]);

/** A local stand-in for api.themoviedb.org that records requests and can answer 429 once. */
class FixtureServer extends Context.Service<
  FixtureServer,
  {
    readonly baseUrl: string;
    readonly requests: Ref.Ref<ReadonlyArray<string>>;
    readonly throttleNext: Ref.Ref<boolean>;
  }
>()("test/TmdbFixtureServer") {}

const fixtureServer = Layer.unwrap(
  Effect.gen(function* () {
    const requests = yield* Ref.make<ReadonlyArray<string>>([]);
    const throttleNext = yield* Ref.make(false);

    const respond = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const url = new URL(request.url, "http://fixture");
      yield* Ref.update(requests, (seen) => [...seen, url.pathname]);

      const authorised =
        url.searchParams.get("api_key") === API_KEY ||
        request.headers["authorization"] === `Bearer ${READ_TOKEN}`;

      if (!authorised) return HttpServerResponse.text('{"status_code":7}', { status: 401 });

      if (yield* Ref.getAndSet(throttleNext, false)) {
        return HttpServerResponse.text('{"status_code":25}', {
          status: 429,
          headers: { "retry-after": "0" },
        });
      }

      const body = FIXTURES.get(url.pathname);

      return body === undefined
        ? HttpServerResponse.text('{"status_code":34}', { status: 404 })
        : HttpServerResponse.text(body, { contentType: "application/json" });
    });

    const server = HttpRouter.serve(HttpRouter.add("GET", "/*", respond), {
      disableLogger: true,
      disableListenLog: true,
    }).pipe(Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0, host: "127.0.0.1" })));

    const service = Layer.effect(
      FixtureServer,
      HttpServer.addressFormattedWith((address) =>
        Effect.succeed(FixtureServer.of({ baseUrl: `${address}/3`, requests, throttleNext })),
      ),
    );

    return service.pipe(Layer.provideMerge(server));
  }),
);

const tmdbOptions = (baseUrl: string, apiKey: string): Tmdb.TmdbOptions => ({
  ...Tmdb.defaultOptions(Option.some(Redacted.make(apiKey))),
  apiBaseUrl: baseUrl,
  imageBaseUrl: "https://images.example/t/p",
  cacheMaxAge: Duration.days(1),
});

/** The plugin under test, pointed at the fixture server, with its cache in a temporary folder. */
const pluginLayer = (apiKey: string) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const server = yield* FixtureServer;
      const fs = yield* FileSystem.FileSystem;
      const dataDir = yield* fs.makeTempDirectoryScoped({ prefix: "movies-tmdb-" });

      return Tmdb.layerWithOptions(tmdbOptions(server.baseUrl, apiKey)).pipe(
        Layer.provide(MetadataCache.layer),
        Layer.provide(testConfigLayer({ DATA_DIR: dataDir })),
      );
    }).pipe(Effect.orDie),
  );

const baseLayer = fixtureServer.pipe(
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
);

describe("TMDB plugin", () => {
  layer(Layer.provideMerge(pluginLayer(API_KEY), baseLayer), { excludeTestServices: true })(
    "with an API key",
    (it) => {
      it.effect("searches, picks the confident match, and maps details", () =>
        Effect.gen(function* () {
          const plugin = yield* MetadataPlugin.Service;
          const query = { kind: "movie", title: "Remux Fixture", year: 2015, ids: {} } as const;
          const matches = yield* plugin.search(query);

          assert.deepStrictEqual(
            matches.map((match) => [match.providerId, match.year]),
            [
              ["500002", 2017],
              ["500001", 2015],
            ],
          );

          const best = MetadataResolver.bestMatch(query, matches);

          assert.strictEqual(best?.providerId, "500001");
          const details = yield* plugin.titleDetails("movie", "500001");

          assert.deepStrictEqual(details, {
            provider: "tmdb",
            kind: "movie",
            providerId: "500001",
            ids: { tmdb: "500001", imdb: "tt5000001", tvdb: undefined },
            title: "Remux Fixture",
            originalTitle: "Remux Fixture",
            year: 2015,
            releaseDate: "2015-06-12",
            plot: "Codecs collide.",
            tagline: "Every stream has a ladder.",
            runtimeMinutes: 98,
            contentRating: "PG-13",
            rating: 6.8,
            genres: ["Action", "Science Fiction"],
            studios: ["Fixture Pictures"],
            images: {
              poster: "https://images.example/t/p/w500/remux-poster.jpg",
              backdrop: "https://images.example/t/p/w1280/remux-backdrop.jpg",
              still: undefined,
            },
          });
        }),
      );

      it.effect("serves repeated requests from the disk cache", () =>
        Effect.gen(function* () {
          const plugin = yield* MetadataPlugin.Service;
          const server = yield* FixtureServer;

          yield* plugin.titleDetails("movie", "10378");
          const before = (yield* Ref.get(server.requests)).length;
          const again = yield* plugin.titleDetails("movie", "10378");

          assert.strictEqual(again.title, "Big Buck Bunny");
          assert.strictEqual((yield* Ref.get(server.requests)).length, before);
        }),
      );

      it.effect("retries after a 429 and resolves external IDs", () =>
        Effect.gen(function* () {
          const plugin = yield* MetadataPlugin.Service;
          const server = yield* FixtureServer;

          yield* Ref.set(server.throttleNext, true);
          const providerId = yield* plugin.findByExternalId("movie", { imdb: "tt1254207" });

          assert.strictEqual(providerId, "10378");
          assert.isFalse(yield* Ref.get(server.throttleNext));
        }),
      );

      it.effect("reports a missing title as a typed failure", () =>
        Effect.gen(function* () {
          const plugin = yield* MetadataPlugin.Service;
          const error = yield* plugin.titleDetails("movie", "404404").pipe(Effect.flip);

          assert.instanceOf(error, MetadataPlugin.MetadataRequestFailed);
          assert.strictEqual(
            error instanceof MetadataPlugin.MetadataRequestFailed && error.status,
            404,
          );
        }),
      );

      it.layer(MetadataResolver.layer)((withResolver) => {
        withResolver.effect("merges a show and its episodes, local NFO values first", () =>
          Effect.gen(function* () {
            const resolver = yield* MetadataResolver.Service;

            const resolved = yield* resolver.title({
              kind: "show",
              title: "Fixture Show",
              year: 2021,
              nameIds: {},
              local: { kind: "show", plot: "Local plot.", genres: [], studios: [], ids: {} },
              artwork: { poster: "Fixture Show (2021)/poster.png" },
            });

            assert.strictEqual(resolved.providerId, "99999");
            assert.strictEqual(resolved.metadata.plot, "Local plot.");
            assert.strictEqual(resolved.metadata.contentRating, "TV-14");
            assert.deepStrictEqual(resolved.metadata.genres, ["Drama"]);
            assert.deepStrictEqual(resolved.metadata.ids, {
              tmdb: "99999",
              imdb: "tt9999999",
              tvdb: "123456",
            });
            assert.deepStrictEqual(resolved.metadata.poster, {
              _tag: "Local",
              path: "Fixture Show (2021)/poster.png",
            });
            assert.deepStrictEqual(resolved.metadata.backdrop, {
              _tag: "Remote",
              url: "https://images.example/t/p/w1280/show-backdrop.jpg",
            });
            assert.deepStrictEqual(resolved.metadata.sources, ["name", "nfo", "provider"]);

            const episode = yield* resolver.episode(resolved.providerId, {
              name: {
                _tag: "Episode",
                showTitle: "Fixture Show",
                showYear: 2021,
                season: 1,
                episodes: [1],
                episodeTitle: "Pilot",
                showIds: {},
              },
              local: { kind: "episode", title: "Pilot (Local)", genres: [], studios: [], ids: {} },
              still: undefined,
              seasonPoster: undefined,
            });

            assert.strictEqual(episode.title, "Pilot (Local)");
            assert.strictEqual(episode.plot, "Provider episode plot.");
            assert.deepStrictEqual(episode.still, {
              _tag: "Remote",
              url: "https://images.example/t/p/w300/s01e01.jpg",
            });
            assert.deepStrictEqual(episode.seasonPoster, {
              _tag: "Remote",
              url: "https://images.example/t/p/w500/season-1.jpg",
            });
          }),
        );
      });
    },
  );

  layer(Layer.provideMerge(pluginLayer(READ_TOKEN), baseLayer), { excludeTestServices: true })(
    "with a read access token",
    (it) => {
      it.effect("sends the token as a bearer header", () =>
        Effect.gen(function* () {
          const plugin = yield* MetadataPlugin.Service;
          const details = yield* plugin.titleDetails("show", "99999");

          assert.strictEqual(details.title, "Fixture Show");
        }),
      );
    },
  );

  const withoutKey = Tmdb.layerWithOptions(Tmdb.defaultOptions(Option.none())).pipe(
    Layer.provide(MetadataCache.layer),
    Layer.provide(testConfigLayer({})),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
  );

  layer(withoutKey, { excludeTestServices: true })("without an API key", (it) => {
    it.effect("reports itself unavailable and fails lookups with a typed error", () =>
      Effect.gen(function* () {
        const plugin = yield* MetadataPlugin.Service;

        assert.deepStrictEqual(yield* plugin.availability, {
          _tag: "Unavailable",
          reason: "missing-credentials",
        });

        const error = yield* plugin
          .search({ kind: "movie", title: "Anything", ids: {} })
          .pipe(Effect.flip);

        assert.instanceOf(error, MetadataPlugin.MetadataProviderUnavailable);
      }),
    );

    it.effect("refuses hosts the manifest does not list", () =>
      Effect.gen(function* () {
        const client = guardHosts(
          {
            id: "example",
            name: "Example",
            version: "1.0.0",
            role: "metadata",
            permissions: { hosts: ["api.example.org"], paths: [] },
          },
          yield* HttpClient.HttpClient,
        );

        const error = yield* client
          .execute(HttpClientRequest.get("http://127.0.0.1:9/"))
          .pipe(Effect.flip);

        assert.instanceOf(error, MetadataPlugin.PluginPermissionDenied);
      }),
    );
  });
});
