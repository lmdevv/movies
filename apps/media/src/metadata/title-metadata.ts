/**
 * Merges what a file's name, its local NFO and artwork, and the metadata provider say about a
 * title or episode. Local values win field by field; the provider fills gaps; the file name is
 * the last resort. Provider failures never fail a scan: the title keeps its local metadata.
 */
import { Cache, Context, Duration, Effect, Exit, Layer, Option, Schema } from "effect";

import type { Artwork } from "../library/artwork.ts";
import type { MediaName } from "../library/media-naming.ts";
import { ExternalIds, type LocalMetadata } from "../library/nfo.ts";
import * as MetadataPlugin from "./metadata-plugin.ts";
import {
  TitleKind,
  type ProviderEpisode,
  type ProviderTitle,
  type TitleMatch,
  type TitleQuery,
} from "./metadata-plugin.ts";

/** An image stored beside the media or hosted by a provider. */
export const ImageRef = Schema.TaggedUnion({
  /** Path relative to the library root. */
  Local: { path: Schema.String },
  Remote: { url: Schema.String },
});

/** An image stored beside the media or hosted by a provider. */
export type ImageRef = typeof ImageRef.Type;

/** Where merged values came from. */
export const MetadataSource = Schema.Literals(["name", "nfo", "provider"]);

/** Merged movie or show metadata. */
export const TitleMetadata = Schema.Struct({
  kind: TitleKind,
  title: Schema.String,
  originalTitle: Schema.optional(Schema.String),
  sortTitle: Schema.optional(Schema.String),
  year: Schema.optional(Schema.Int),
  releaseDate: Schema.optional(Schema.String),
  plot: Schema.optional(Schema.String),
  tagline: Schema.optional(Schema.String),
  runtimeMinutes: Schema.optional(Schema.Int),
  contentRating: Schema.optional(Schema.String),
  rating: Schema.optional(Schema.Finite),
  genres: Schema.Array(Schema.String),
  studios: Schema.Array(Schema.String),
  ids: ExternalIds,
  poster: Schema.optional(ImageRef),
  backdrop: Schema.optional(ImageRef),
  logo: Schema.optional(ImageRef),
  banner: Schema.optional(ImageRef),
  sources: Schema.Array(MetadataSource),
});

/** Merged movie or show metadata. */
export interface TitleMetadata extends Schema.Schema.Type<typeof TitleMetadata> {}

/** Merged episode metadata. For a multi-episode file, values describe the first episode. */
export const EpisodeMetadata = Schema.Struct({
  season: Schema.Int,
  episodes: Schema.NonEmptyArray(Schema.Int),
  title: Schema.optional(Schema.String),
  plot: Schema.optional(Schema.String),
  airDate: Schema.optional(Schema.String),
  runtimeMinutes: Schema.optional(Schema.Int),
  rating: Schema.optional(Schema.Finite),
  still: Schema.optional(ImageRef),
  seasonPoster: Schema.optional(ImageRef),
  sources: Schema.Array(MetadataSource),
});

/** Merged episode metadata. */
export interface EpisodeMetadata extends Schema.Schema.Type<typeof EpisodeMetadata> {}

/** Local inputs for a movie or a show. */
export interface TitleInput {
  readonly kind: TitleKind;
  readonly title: string;
  readonly year: number | undefined;
  readonly nameIds: ExternalIds;
  readonly local: LocalMetadata | undefined;
  readonly artwork: Artwork;
}

/** Local inputs for an episode. */
export interface EpisodeInput {
  readonly name: Extract<MediaName, { readonly _tag: "Episode" }>;
  readonly local: LocalMetadata | undefined;
  readonly still: string | undefined;
  readonly seasonPoster: string | undefined;
}

/** A merged title plus the provider ID needed for its episodes. */
export interface ResolvedTitle {
  readonly metadata: TitleMetadata;
  readonly providerId: string | undefined;
}

/** Resolves merged metadata. Never fails. */
export interface Interface {
  readonly title: (input: TitleInput) => Effect.Effect<ResolvedTitle>;
  readonly episode: (
    showProviderId: string | undefined,
    input: EpisodeInput,
  ) => Effect.Effect<EpisodeMetadata>;
}

/** The metadata resolver. */
export class Service extends Context.Service<Service, Interface>()(
  "@movies/media/MetadataResolver",
) {}

const normaliseTitle = (title: string): string =>
  title
    .normalize("NFKD")
    .replaceAll(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replaceAll("&", "and")
    .replaceAll(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/^(?:the|a|an) /, "");

/**
 * The search hit that confidently matches `query`: the same normalised title, and the same
 * year (or one year off, for regional release dates) when the query has a year.
 */
export const bestMatch = (
  query: TitleQuery,
  matches: ReadonlyArray<TitleMatch>,
): TitleMatch | undefined => {
  const wanted = normaliseTitle(query.title);
  const sameTitle = matches.filter((match) => normaliseTitle(match.title) === wanted);

  if (query.year === undefined) return sameTitle[0];
  const { year } = query;

  return (
    sameTitle.find((match) => match.year === year) ??
    sameTitle.find((match) => match.year !== undefined && Math.abs(match.year - year) === 1)
  );
};

const local = (path: string | undefined): ImageRef | undefined =>
  path === undefined ? undefined : ImageRef.cases.Local.make({ path });

const remote = (url: string | undefined): ImageRef | undefined =>
  url === undefined ? undefined : ImageRef.cases.Remote.make({ url });

const nonEmpty = <A>(
  primary: ReadonlyArray<A> | undefined,
  fallback: ReadonlyArray<A> | undefined,
): ReadonlyArray<A> => (primary !== undefined && primary.length > 0 ? primary : (fallback ?? []));

const sourcesOf = (nfo: boolean, provider: boolean): ReadonlyArray<typeof MetadataSource.Type> => [
  "name",
  ...(nfo ? (["nfo"] as const) : []),
  ...(provider ? (["provider"] as const) : []),
];

/** Field-by-field merge: local NFO, then provider, then the file name. */
export const mergeTitle = (
  input: TitleInput,
  provider: ProviderTitle | undefined,
): TitleMetadata => {
  const nfo = input.local;

  return {
    kind: input.kind,
    title: nfo?.title ?? provider?.title ?? input.title,
    originalTitle: nfo?.originalTitle ?? provider?.originalTitle,
    sortTitle: nfo?.sortTitle,
    year: nfo?.year ?? provider?.year ?? input.year,
    releaseDate: nfo?.releaseDate ?? provider?.releaseDate,
    plot: nfo?.plot ?? provider?.plot,
    tagline: nfo?.tagline ?? provider?.tagline,
    runtimeMinutes: nfo?.runtimeMinutes ?? provider?.runtimeMinutes,
    contentRating: nfo?.contentRating ?? provider?.contentRating,
    rating: nfo?.rating ?? provider?.rating,
    genres: nonEmpty(nfo?.genres, provider?.genres),
    studios: nonEmpty(nfo?.studios, provider?.studios),
    ids: {
      tmdb: nfo?.ids.tmdb ?? input.nameIds.tmdb ?? provider?.ids.tmdb,
      imdb: nfo?.ids.imdb ?? input.nameIds.imdb ?? provider?.ids.imdb,
      tvdb: nfo?.ids.tvdb ?? input.nameIds.tvdb ?? provider?.ids.tvdb,
    },
    poster: local(input.artwork.poster) ?? remote(provider?.images.poster),
    backdrop: local(input.artwork.backdrop) ?? remote(provider?.images.backdrop),
    logo: local(input.artwork.logo),
    banner: local(input.artwork.banner),
    sources: sourcesOf(nfo !== undefined, provider !== undefined),
  };
};

/** Field-by-field merge for an episode: local NFO, then provider, then the file name. */
export const mergeEpisode = (
  input: EpisodeInput,
  provider: ProviderEpisode | undefined,
  providerSeasonPoster: string | undefined,
): EpisodeMetadata => ({
  season: input.name.season,
  episodes: input.name.episodes,
  title: input.local?.title ?? provider?.title ?? input.name.episodeTitle,
  plot: input.local?.plot ?? provider?.plot,
  airDate: input.local?.releaseDate ?? provider?.airDate,
  runtimeMinutes: input.local?.runtimeMinutes ?? provider?.runtimeMinutes,
  rating: input.local?.rating ?? provider?.rating,
  still: local(input.still) ?? remote(provider?.images.still),
  seasonPoster: local(input.seasonPoster) ?? remote(providerSeasonPoster),
  sources: sourcesOf(input.local !== undefined, provider !== undefined),
});

const LOOKUP_CACHE = { capacity: 4096, success: Duration.hours(1) };

/** Keeps found results for an hour; misses and failures are retried on the next lookup. */
const cacheSuccessesOnly = <A, E>(exit: Exit.Exit<Option.Option<A>, E>): Duration.Duration =>
  Exit.isSuccess(exit) && Option.isSome(exit.value) ? LOOKUP_CACHE.success : Duration.zero;

/** A resolver over the active metadata plugin. */
export const make = Effect.gen(function* () {
  const plugin = yield* MetadataPlugin.Service;

  const logged =
    (operation: string) =>
    <A>(effect: Effect.Effect<A, MetadataPlugin.MetadataError>): Effect.Effect<Option.Option<A>> =>
      effect.pipe(
        Effect.asSome,
        Effect.catchTag("MetadataProviderUnavailable", () => Effect.succeedNone),
        Effect.catch((error) =>
          Effect.logWarning("MetadataResolver.provider_failed", error).pipe(
            Effect.annotateLogs({ operation, provider: plugin.manifest.id }),
            Effect.as(Option.none<A>()),
          ),
        ),
      );

  const providerTitle = Effect.fn("MetadataResolver.providerTitle")(function* (query: TitleQuery) {
    const providerId =
      query.ids.tmdb ??
      (yield* plugin.findByExternalId(query.kind, query.ids)) ??
      bestMatch(query, yield* plugin.search(query))?.providerId;

    return providerId === undefined
      ? undefined
      : yield* plugin.titleDetails(query.kind, providerId);
  });

  // Plain objects and arrays are compared structurally by `Equal`, so equal queries share one
  // lookup, including concurrent ones from episodes of the same show.
  const titles = yield* Cache.makeWith(
    (query: TitleQuery) => logged("title")(providerTitle(query)),
    {
      capacity: LOOKUP_CACHE.capacity,
      timeToLive: cacheSuccessesOnly,
    },
  );

  const seasons = yield* Cache.makeWith(
    ([showId, season]: readonly [string, number]) =>
      logged("season")(plugin.seasonDetails(showId, season)),
    { capacity: LOOKUP_CACHE.capacity, timeToLive: cacheSuccessesOnly },
  );

  const title = Effect.fn("MetadataResolver.title")(function* (input: TitleInput) {
    const available = MetadataPlugin.PluginAvailability.guards.Available(
      yield* plugin.availability,
    );

    const ids = {
      tmdb: input.local?.ids.tmdb ?? input.nameIds.tmdb,
      imdb: input.local?.ids.imdb ?? input.nameIds.imdb,
      tvdb: input.local?.ids.tvdb ?? input.nameIds.tvdb,
    };

    const query: TitleQuery = {
      kind: input.kind,
      title: input.local?.title ?? input.title,
      year: input.local?.year ?? input.year,
      ids,
    };

    const provider = available ? Option.getOrUndefined(yield* Cache.get(titles, query)) : undefined;

    return {
      metadata: mergeTitle(input, provider),
      providerId: provider?.providerId,
    } satisfies ResolvedTitle;
  });

  const episode = Effect.fn("MetadataResolver.episode")(function* (
    showProviderId: string | undefined,
    input: EpisodeInput,
  ) {
    const season =
      showProviderId === undefined
        ? undefined
        : Option.getOrUndefined(
            yield* Cache.get(seasons, [showProviderId, input.name.season] as const),
          );

    const providerEpisode = season?.episodes.find(
      (candidate) => candidate.episode === input.name.episodes[0],
    );

    return mergeEpisode(input, providerEpisode, season?.images.poster);
  });

  return Service.of({ title, episode });
});

/** The resolver over the provided metadata plugin. */
export const layer: Layer.Layer<Service, never, MetadataPlugin.Service> = Layer.effect(
  Service,
  make,
);
