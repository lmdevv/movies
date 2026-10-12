/**
 * The typed contract every metadata plugin implements (plugin role `metadata`). A plugin declares
 * the hosts and paths it may touch in its manifest; `guardHosts` enforces the host list on the
 * HTTP client a plugin is given.
 */
import { Context, Effect, Schema } from "effect";
import { HttpClient, type HttpClientError } from "effect/http";

import { ExternalIds } from "../library/nfo.ts";

/** What a plugin may access. Requests to any other host fail with `PluginPermissionDenied`. */
const PluginPermissions = Schema.Struct({
  hosts: Schema.Array(Schema.String),
  paths: Schema.Array(Schema.String),
});

/** Identity, role, and permissions of a plugin. */
export const PluginManifest = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  version: Schema.String,
  role: Schema.Literal("metadata"),
  permissions: PluginPermissions,
});

/** Identity, role, and permissions of a plugin. */
export interface PluginManifest extends Schema.Schema.Type<typeof PluginManifest> {}

/** Whether a plugin can serve requests right now. */
export const PluginAvailability = Schema.TaggedUnion({
  Available: {},
  Unavailable: { reason: Schema.Literals(["missing-credentials", "disabled"]) },
});

/** Whether a plugin can serve requests right now. */
export type PluginAvailability = typeof PluginAvailability.Type;

/** Movie or show. */
export const TitleKind = Schema.Literals(["movie", "show"]);

/** Movie or show. */
export type TitleKind = typeof TitleKind.Type;

/** A title to look up: from local IDs when known, otherwise by name and year. */
export const TitleQuery = Schema.Struct({
  kind: TitleKind,
  title: Schema.String,
  year: Schema.optional(Schema.Int),
  ids: ExternalIds,
});

/** A title to look up. */
export interface TitleQuery extends Schema.Schema.Type<typeof TitleQuery> {}

/** One search hit. */
export const TitleMatch = Schema.Struct({
  kind: TitleKind,
  /** The provider's own ID, such as a TMDB ID. */
  providerId: Schema.String,
  title: Schema.String,
  year: Schema.optional(Schema.Int),
});

/** One search hit. */
export interface TitleMatch extends Schema.Schema.Type<typeof TitleMatch> {}

/** Image URLs a provider knows for a title, season, or episode. */
export const ProviderImages = Schema.Struct({
  poster: Schema.optional(Schema.String),
  backdrop: Schema.optional(Schema.String),
  still: Schema.optional(Schema.String),
});

/** Image URLs a provider knows. */
export interface ProviderImages extends Schema.Schema.Type<typeof ProviderImages> {}

/** Movie or show details from a provider. */
export const ProviderTitle = Schema.Struct({
  provider: Schema.String,
  kind: TitleKind,
  providerId: Schema.String,
  ids: ExternalIds,
  title: Schema.String,
  originalTitle: Schema.optional(Schema.String),
  year: Schema.optional(Schema.Int),
  releaseDate: Schema.optional(Schema.String),
  plot: Schema.optional(Schema.String),
  tagline: Schema.optional(Schema.String),
  runtimeMinutes: Schema.optional(Schema.Int),
  contentRating: Schema.optional(Schema.String),
  rating: Schema.optional(Schema.Finite),
  genres: Schema.Array(Schema.String),
  studios: Schema.Array(Schema.String),
  images: ProviderImages,
});

/** Movie or show details from a provider. */
export interface ProviderTitle extends Schema.Schema.Type<typeof ProviderTitle> {}

/** Episode details from a provider. */
export const ProviderEpisode = Schema.Struct({
  season: Schema.Int,
  episode: Schema.Int,
  title: Schema.optional(Schema.String),
  plot: Schema.optional(Schema.String),
  airDate: Schema.optional(Schema.String),
  runtimeMinutes: Schema.optional(Schema.Int),
  rating: Schema.optional(Schema.Finite),
  images: ProviderImages,
});

/** Episode details from a provider. */
export interface ProviderEpisode extends Schema.Schema.Type<typeof ProviderEpisode> {}

/** Season details, with its episodes, from a provider. */
export const ProviderSeason = Schema.Struct({
  season: Schema.Int,
  title: Schema.optional(Schema.String),
  plot: Schema.optional(Schema.String),
  airDate: Schema.optional(Schema.String),
  images: ProviderImages,
  episodes: Schema.Array(ProviderEpisode),
});

/** Season details from a provider. */
export interface ProviderSeason extends Schema.Schema.Type<typeof ProviderSeason> {}

/** The plugin cannot serve requests, for example because no API key is configured. */
export class MetadataProviderUnavailable extends Schema.TaggedError<MetadataProviderUnavailable>()(
  "MetadataProviderUnavailable",
  { provider: Schema.String, reason: Schema.Literals(["missing-credentials", "disabled"]) },
) {
  override get message(): string {
    return `Metadata provider unavailable: ${this.provider} (${this.reason})`;
  }
}

/** A provider request failed in transport, status, rate limiting, or decoding. */
export class MetadataRequestFailed extends Schema.TaggedError<MetadataRequestFailed>()(
  "MetadataRequestFailed",
  {
    provider: Schema.String,
    operation: Schema.String,
    /** HTTP status when the provider answered. */
    status: Schema.NullOr(Schema.Int),
    /** What went wrong, without the request URL (it may carry the API key). */
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Metadata request failed: ${this.provider} ${this.operation} (status ${String(this.status)}): ${this.detail}`;
  }
}

/** A plugin tried to reach a host its manifest does not list. */
export class PluginPermissionDenied extends Schema.TaggedError<PluginPermissionDenied>()(
  "PluginPermissionDenied",
  { plugin: Schema.String, host: Schema.String },
) {
  override get message(): string {
    return `Plugin permission denied: ${this.plugin} may not reach ${this.host}`;
  }
}

/** Failures a metadata lookup can report. */
export type MetadataError =
  | MetadataProviderUnavailable
  | MetadataRequestFailed
  | PluginPermissionDenied;

/** A metadata provider. */
export interface Interface {
  readonly manifest: PluginManifest;
  readonly availability: Effect.Effect<PluginAvailability>;
  /** Titles matching a name and optional year, best match first. */
  readonly search: (query: TitleQuery) => Effect.Effect<ReadonlyArray<TitleMatch>, MetadataError>;
  /** Resolves external IDs (IMDb, TVDB) to the provider's own ID, when it knows the title. */
  readonly findByExternalId: (
    kind: TitleKind,
    ids: ExternalIds,
  ) => Effect.Effect<string | undefined, MetadataError>;
  readonly titleDetails: (
    kind: TitleKind,
    providerId: string,
  ) => Effect.Effect<ProviderTitle, MetadataError>;
  readonly seasonDetails: (
    showId: string,
    season: number,
  ) => Effect.Effect<ProviderSeason, MetadataError>;
  readonly episodeDetails: (
    showId: string,
    season: number,
    episode: number,
  ) => Effect.Effect<ProviderEpisode, MetadataError>;
}

/** The active metadata plugin. */
export class Service extends Context.Service<Service, Interface>()(
  "@movies/media/MetadataPlugin",
) {}

/**
 * Wraps `client` so every request to a host outside `manifest.permissions.hosts` fails with
 * `PluginPermissionDenied` before any bytes leave the process.
 */
export const guardHosts = (
  manifest: PluginManifest,
  client: HttpClient.HttpClient,
): HttpClient.HttpClient.With<HttpClientError.HttpClientError | PluginPermissionDenied> => {
  const allowed = new Set(manifest.permissions.hosts.map((host) => host.toLowerCase()));

  return HttpClient.mapRequestEffect(client, (request) => {
    const host = new URL(request.url).host.toLowerCase();

    return allowed.has(host)
      ? Effect.succeed(request)
      : Effect.fail(new PluginPermissionDenied({ plugin: manifest.id, host }));
  });
};
