/**
 * The in-repo TMDB metadata plugin. It accepts either a v3 API key (sent as the `api_key` query
 * parameter) or a v4 read access token (sent as a bearer token). Responses are cached on disk,
 * requests are paced by a rate limiter that also honours `429 Retry-After`, and Effect's client
 * spans are disabled for these requests because their URLs may carry the key; each operation
 * records its own span with the request path only.
 */
import { Duration, Effect, identity, Layer, Option, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { RateLimiter } from "effect/persistence";

import type { ExternalIds } from "../library/nfo.ts";
import * as MediaConfig from "../media-config.ts";
import * as DiskCache from "../disk-cache.ts";
import {
  guardHosts,
  MetadataProviderUnavailable,
  MetadataRequestFailed,
  type PluginManifest,
  type ProviderEpisode,
  type ProviderImages,
  type ProviderSeason,
  type ProviderTitle,
  Service,
  type TitleKind,
  type TitleMatch,
  type TitleQuery,
} from "./metadata-plugin.ts";

/** How the TMDB plugin reaches TMDB. */
export interface TmdbOptions {
  /** v3 API key or v4 read access token; absent makes the plugin report itself unavailable. */
  readonly apiKey: Option.Option<Redacted.Redacted>;
  /** API root, `https://api.themoviedb.org/3` in production. */
  readonly apiBaseUrl: string;
  /** Image root used to build poster, backdrop, and still URLs. */
  readonly imageBaseUrl: string;
  /** Response language, such as `en-US`. */
  readonly language: string;
  readonly cacheMaxAge: Duration.Duration;
  /** Request budget per second, shared by every TMDB request of this process. */
  readonly requestsPerSecond: number;
}

/** Production TMDB endpoints with a one-week cache and a conservative request budget. */
export const defaultOptions = (apiKey: Option.Option<Redacted.Redacted>): TmdbOptions => ({
  apiKey,
  apiBaseUrl: "https://api.themoviedb.org/3",
  imageBaseUrl: "https://image.tmdb.org/t/p",
  language: "en-US",
  cacheMaxAge: Duration.days(7),
  requestsPerSecond: 20,
});

const PROVIDER = "tmdb";

const NamedList = Schema.Array(Schema.Struct({ name: Schema.String }));

const nullable = <S extends Schema.Top>(schema: S) => Schema.optionalKey(Schema.NullOr(schema));

const SearchMovies = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({ id: Schema.Int, title: Schema.String, release_date: nullable(Schema.String) }),
  ),
});

const SearchShows = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({ id: Schema.Int, name: Schema.String, first_air_date: nullable(Schema.String) }),
  ),
});

const FindResults = Schema.Struct({
  movie_results: Schema.Array(Schema.Struct({ id: Schema.Int })),
  tv_results: Schema.Array(Schema.Struct({ id: Schema.Int })),
});

const MovieDetails = Schema.Struct({
  id: Schema.Int,
  imdb_id: nullable(Schema.String),
  title: Schema.String,
  original_title: nullable(Schema.String),
  overview: nullable(Schema.String),
  tagline: nullable(Schema.String),
  release_date: nullable(Schema.String),
  runtime: nullable(Schema.Int),
  genres: Schema.optionalKey(NamedList),
  production_companies: Schema.optionalKey(NamedList),
  vote_average: nullable(Schema.Finite),
  poster_path: nullable(Schema.String),
  backdrop_path: nullable(Schema.String),
  release_dates: Schema.optionalKey(
    Schema.Struct({
      results: Schema.Array(
        Schema.Struct({
          iso_3166_1: Schema.String,
          release_dates: Schema.Array(Schema.Struct({ certification: Schema.String })),
        }),
      ),
    }),
  ),
});

const ShowDetails = Schema.Struct({
  id: Schema.Int,
  name: Schema.String,
  original_name: nullable(Schema.String),
  overview: nullable(Schema.String),
  tagline: nullable(Schema.String),
  first_air_date: nullable(Schema.String),
  episode_run_time: Schema.optionalKey(Schema.Array(Schema.Int)),
  genres: Schema.optionalKey(NamedList),
  networks: Schema.optionalKey(NamedList),
  vote_average: nullable(Schema.Finite),
  poster_path: nullable(Schema.String),
  backdrop_path: nullable(Schema.String),
  external_ids: Schema.optionalKey(
    Schema.Struct({ imdb_id: nullable(Schema.String), tvdb_id: nullable(Schema.Int) }),
  ),
  content_ratings: Schema.optionalKey(
    Schema.Struct({
      results: Schema.Array(Schema.Struct({ iso_3166_1: Schema.String, rating: Schema.String })),
    }),
  ),
});

const EpisodeDetails = Schema.Struct({
  season_number: Schema.Int,
  episode_number: Schema.Int,
  name: nullable(Schema.String),
  overview: nullable(Schema.String),
  air_date: nullable(Schema.String),
  runtime: nullable(Schema.Int),
  vote_average: nullable(Schema.Finite),
  still_path: nullable(Schema.String),
});

const SeasonDetails = Schema.Struct({
  season_number: Schema.Int,
  name: nullable(Schema.String),
  overview: nullable(Schema.String),
  air_date: nullable(Schema.String),
  poster_path: nullable(Schema.String),
  episodes: Schema.Array(EpisodeDetails),
});

const yearOf = (date: string | null | undefined): number | undefined => {
  const year =
    date === null || date === undefined ? Number.NaN : Number.parseInt(date.slice(0, 4), 10);

  return Number.isFinite(year) ? year : undefined;
};

const text = (value: string | null | undefined): string | undefined =>
  value === null || value === undefined || value.trim() === "" ? undefined : value.trim();

const positive = (value: number | null | undefined): number | undefined =>
  value === null || value === undefined || value <= 0 ? undefined : value;

const usCertification = (
  results: ReadonlyArray<{
    readonly iso_3166_1: string;
    readonly certification?: string;
    readonly rating?: string;
  }>,
): string | undefined => {
  const us = results.find((result) => result.iso_3166_1 === "US");

  return text(us?.certification ?? us?.rating);
};

/** Builds the TMDB plugin. */
export const make = Effect.fn("Tmdb.make")(function* (options: TmdbOptions) {
  const cache = yield* DiskCache.Service;
  const apiBase = new URL(options.apiBaseUrl);

  const manifest: PluginManifest = {
    id: PROVIDER,
    name: "The Movie Database",
    version: "1.0.0",
    role: "metadata",
    permissions: { hosts: [apiBase.host], paths: ["DATA_DIR/cache/tmdb"] },
  };

  // Paces every TMDB request of this process and retries `429` answers after `Retry-After`.
  const client = guardHosts(manifest, yield* HttpClient.HttpClient).pipe(
    HttpClient.withRateLimiter({
      limiter: yield* RateLimiter.RateLimiter,
      key: PROVIDER,
      limit: options.requestsPerSecond,
      window: "1 second",
      algorithm: "token-bucket",
      times: 3,
    }),
  );

  const image = (size: string, path: string | null | undefined): string | undefined =>
    path === null || path === undefined ? undefined : `${options.imageBaseUrl}/${size}${path}`;

  /** Fetches `path` (cached), then decodes it with `schema`. */
  const request = <S extends Schema.Codec<unknown, unknown>>(
    operation: string,
    path: string,
    params: Readonly<Record<string, string>>,
    schema: S,
  ) =>
    Effect.gen(function* () {
      if (Option.isNone(options.apiKey)) {
        return yield* new MetadataProviderUnavailable({
          provider: PROVIDER,
          reason: "missing-credentials",
        });
      }

      const key = Redacted.value(options.apiKey.value);
      const query = new URLSearchParams({ ...params, language: options.language });
      query.sort();
      const cacheKey = `${path}?${query.toString()}`;

      const failed = (status: number | null, detail: string) =>
        new MetadataRequestFailed({ provider: PROVIDER, operation, status, detail });

      const cached = yield* cache.read(PROVIDER, cacheKey, options.cacheMaxAge);

      const body = Option.isSome(cached)
        ? cached.value
        : yield* Effect.gen(function* () {
            const isReadAccessToken = key.startsWith("eyJ");

            if (!isReadAccessToken) query.set("api_key", key);

            const outgoing = HttpClientRequest.get(
              `${options.apiBaseUrl}${path}?${query.toString()}`,
            ).pipe(
              HttpClientRequest.acceptJson,
              isReadAccessToken ? HttpClientRequest.bearerToken(key) : identity,
            );

            const response = yield* client.execute(outgoing).pipe(
              Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
              Effect.catchTags({
                HttpClientError: (error) =>
                  Effect.fail(
                    failed(
                      error.response?.status ?? null,
                      error.reason.description ?? "request failed",
                    ),
                  ),
                RateLimiterError: () => Effect.fail(failed(429, "rate limited")),
              }),
            );

            if (response.status < 200 || response.status >= 300) {
              return yield* failed(response.status, "unexpected status");
            }

            const fresh = yield* response.text.pipe(
              Effect.mapError((error) =>
                failed(response.status, error.reason.description ?? "unreadable body"),
              ),
            );

            yield* cache.write(PROVIDER, cacheKey, fresh);

            return fresh;
          });

      return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(body).pipe(
        Effect.mapError((error) => failed(null, error.message)),
      );
    }).pipe(Effect.withSpan(`Tmdb.${operation}`, { attributes: { "tmdb.path": path } }));

  const search = Effect.fn("Tmdb.search")(function* (query: TitleQuery) {
    const year =
      query.year === undefined
        ? {}
        : { [query.kind === "movie" ? "year" : "first_air_date_year"]: String(query.year) };

    if (query.kind === "movie") {
      const found = yield* request(
        "searchMovie",
        "/search/movie",
        { query: query.title, include_adult: "false", ...year },
        SearchMovies,
      );

      return found.results.map((result): TitleMatch => ({
        kind: "movie",
        providerId: String(result.id),
        title: result.title,
        year: yearOf(result.release_date),
      }));
    }

    const found = yield* request(
      "searchShow",
      "/search/tv",
      { query: query.title, include_adult: "false", ...year },
      SearchShows,
    );

    return found.results.map((result): TitleMatch => ({
      kind: "show",
      providerId: String(result.id),
      title: result.name,
      year: yearOf(result.first_air_date),
    }));
  });

  const findByExternalId = Effect.fn("Tmdb.findByExternalId")(function* (
    kind: TitleKind,
    ids: ExternalIds,
  ) {
    const lookup =
      ids.imdb === undefined
        ? ids.tvdb === undefined
          ? undefined
          : { source: "tvdb_id", id: ids.tvdb }
        : { source: "imdb_id", id: ids.imdb };

    if (lookup === undefined) return undefined;

    const found = yield* request(
      "find",
      `/find/${encodeURIComponent(lookup.id)}`,
      { external_source: lookup.source },
      FindResults,
    );

    const match = kind === "movie" ? found.movie_results[0] : found.tv_results[0];

    return match === undefined ? undefined : String(match.id);
  });

  const titleDetails = Effect.fn("Tmdb.titleDetails")(function* (
    kind: TitleKind,
    providerId: string,
  ) {
    const id = encodeURIComponent(providerId);

    if (kind === "movie") {
      const movie = yield* request(
        "movieDetails",
        `/movie/${id}`,
        { append_to_response: "release_dates" },
        MovieDetails,
      );

      return {
        provider: PROVIDER,
        kind,
        providerId: String(movie.id),
        ids: { tmdb: String(movie.id), imdb: text(movie.imdb_id), tvdb: undefined },
        title: movie.title,
        originalTitle: text(movie.original_title),
        year: yearOf(movie.release_date),
        releaseDate: text(movie.release_date),
        plot: text(movie.overview),
        tagline: text(movie.tagline),
        runtimeMinutes: positive(movie.runtime),
        contentRating: usCertification(
          movie.release_dates?.results.flatMap((result) =>
            result.release_dates.map((date) => ({
              iso_3166_1: result.iso_3166_1,
              certification: date.certification,
            })),
          ) ?? [],
        ),
        rating: positive(movie.vote_average),
        genres: (movie.genres ?? []).map((genre) => genre.name),
        studios: (movie.production_companies ?? []).map((company) => company.name),
        images: {
          poster: image("w500", movie.poster_path),
          backdrop: image("w1280", movie.backdrop_path),
          still: undefined,
        },
      } satisfies ProviderTitle;
    }

    const show = yield* request(
      "showDetails",
      `/tv/${id}`,
      { append_to_response: "external_ids,content_ratings" },
      ShowDetails,
    );

    const tvdb = show.external_ids?.tvdb_id;

    return {
      provider: PROVIDER,
      kind,
      providerId: String(show.id),
      ids: {
        tmdb: String(show.id),
        imdb: text(show.external_ids?.imdb_id),
        tvdb: tvdb === null || tvdb === undefined ? undefined : String(tvdb),
      },
      title: show.name,
      originalTitle: text(show.original_name),
      year: yearOf(show.first_air_date),
      releaseDate: text(show.first_air_date),
      plot: text(show.overview),
      tagline: text(show.tagline),
      runtimeMinutes: positive(show.episode_run_time?.[0]),
      contentRating: usCertification(show.content_ratings?.results ?? []),
      rating: positive(show.vote_average),
      genres: (show.genres ?? []).map((genre) => genre.name),
      studios: (show.networks ?? []).map((network) => network.name),
      images: {
        poster: image("w500", show.poster_path),
        backdrop: image("w1280", show.backdrop_path),
        still: undefined,
      },
    } satisfies ProviderTitle;
  });

  const toEpisode = (episode: typeof EpisodeDetails.Type): ProviderEpisode => ({
    season: episode.season_number,
    episode: episode.episode_number,
    title: text(episode.name),
    plot: text(episode.overview),
    airDate: text(episode.air_date),
    runtimeMinutes: positive(episode.runtime),
    rating: positive(episode.vote_average),
    images: {
      poster: undefined,
      backdrop: undefined,
      still: image("w300", episode.still_path),
    } satisfies ProviderImages,
  });

  const seasonDetails = Effect.fn("Tmdb.seasonDetails")(function* (showId: string, season: number) {
    const found = yield* request(
      "seasonDetails",
      `/tv/${encodeURIComponent(showId)}/season/${season}`,
      {},
      SeasonDetails,
    );

    return {
      season: found.season_number,
      title: text(found.name),
      plot: text(found.overview),
      airDate: text(found.air_date),
      images: { poster: image("w500", found.poster_path), backdrop: undefined, still: undefined },
      episodes: found.episodes.map(toEpisode),
    } satisfies ProviderSeason;
  });

  const episodeDetails = Effect.fn("Tmdb.episodeDetails")(function* (
    showId: string,
    season: number,
    episode: number,
  ) {
    const found = yield* request(
      "episodeDetails",
      `/tv/${encodeURIComponent(showId)}/season/${season}/episode/${episode}`,
      {},
      EpisodeDetails,
    );

    return toEpisode(found);
  });

  return Service.of({
    manifest,
    availability: Effect.succeed(
      Option.isSome(options.apiKey)
        ? { _tag: "Available" as const }
        : { _tag: "Unavailable" as const, reason: "missing-credentials" as const },
    ),
    search,
    findByExternalId,
    titleDetails,
    seasonDetails,
    episodeDetails,
  });
});

/** The TMDB plugin with explicit options; tests point it at a local server. */
export const layerWithOptions = (
  options: TmdbOptions,
): Layer.Layer<Service, never, DiskCache.Service | HttpClient.HttpClient> =>
  Layer.effect(Service, make(options)).pipe(
    Layer.provide(RateLimiter.layer),
    Layer.provide(RateLimiter.layerStoreMemory),
  );

/** The TMDB plugin configured from `TMDB_API_KEY`. */
export const layer: Layer.Layer<
  Service,
  never,
  MediaConfig.Service | DiskCache.Service | HttpClient.HttpClient
> = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* MediaConfig.Service;

    return layerWithOptions(defaultOptions(config.tmdbApiKey));
  }),
);
