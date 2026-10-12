/**
 * Metadata jobs: an admin refreshed a title (`metadata.refresh`) or chose its match by hand
 * (`metadata.fixMatch`). The job looks the title up at the metadata provider (the chosen match,
 * else its TMDB ID, else its IMDb or TVDB ID, else a confident name and year search), writes the
 * title and its known episodes with `mediaService:applyMetadata`, and keeps the title's current
 * artwork where the provider has none. Convex marks a hand-picked match manual, so scans keep it.
 */
import type { ScannedEpisode } from "@movies/contracts/models/scan";
import type { FunctionResult } from "../convex/media-backend.ts";
import { Effect, Match, Option } from "effect";

import * as ArtworkKeys from "../artwork/artwork-keys.ts";
import { toScannedEpisode, toScannedTitle } from "../convex/catalog-records.ts";
import * as MediaBackend from "../convex/media-backend.ts";
import * as MetadataPlugin from "../metadata/metadata-plugin.ts";
import type { ProviderSeason, ProviderTitle } from "../metadata/metadata-plugin.ts";
import { bestMatch, ImageRef } from "../metadata/title-metadata.ts";
import type { EpisodeMetadata, TitleMetadata } from "../metadata/title-metadata.ts";
import { JobFailed, type JobHandler } from "./job-worker.ts";

/** Most episodes one `applyMetadata` call carries. */
const EPISODE_BATCH = 100;

const remote = (url: string | undefined) =>
  url === undefined ? undefined : ImageRef.cases.Remote.make({ url });

const providerFailure = Match.type<MetadataPlugin.MetadataError>().pipe(
  Match.tagsExhaustive({
    MetadataProviderUnavailable: (error) => new JobFailed({ message: error.message, retry: false }),
    MetadataRequestFailed: (error) => new JobFailed({ message: error.message, retry: true }),
    PluginPermissionDenied: (error) => new JobFailed({ message: error.message, retry: false }),
  }),
);

const titleMetadataOf = (title: ProviderTitle): TitleMetadata => ({
  kind: title.kind,
  title: title.title,
  originalTitle: title.originalTitle,
  year: title.year,
  releaseDate: title.releaseDate,
  plot: title.plot,
  tagline: title.tagline,
  runtimeMinutes: title.runtimeMinutes,
  contentRating: title.contentRating,
  rating: title.rating,
  genres: title.genres,
  studios: title.studios,
  ids: { ...title.ids, tmdb: title.providerId },
  poster: remote(title.images.poster),
  backdrop: remote(title.images.backdrop),
  sources: ["provider"],
});

const episodeMetadataOf = (season: ProviderSeason, episode: number): EpisodeMetadata => {
  const found = season.episodes.find((candidate) => candidate.episode === episode);

  return {
    season: season.season,
    episodes: [episode],
    title: found?.title,
    plot: found?.plot,
    airDate: found?.airDate,
    runtimeMinutes: found?.runtimeMinutes,
    rating: found?.rating,
    still: remote(found?.images.still),
    seasonPoster: remote(season.images.poster),
    sources: ["provider"],
  };
};

/** Convex failures return the job to the queue. */
const backendFailure = (error: { readonly message: string }) =>
  new JobFailed({ message: error.message, retry: true });

/** The metadata job handler. */
export const handler: Effect.Effect<
  JobHandler,
  never,
  MediaBackend.Service | MetadataPlugin.Service | ArtworkKeys.Service
> = Effect.gen(function* () {
  const backend = yield* MediaBackend.Service;
  const plugin = yield* MetadataPlugin.Service;
  const keys = yield* ArtworkKeys.Service;

  /** The provider ID of the title: chosen, known, found by external ID, or searched. */
  const providerIdOf = Effect.fn("MetadataJob.providerId")(function* (
    target: FunctionResult<"mediaService.metadataTarget">,
    chosen: Option.Option<string>,
  ) {
    if (Option.isSome(chosen)) return Option.some(chosen.value);

    if (target.externalIds.tmdb !== null) return Option.some(target.externalIds.tmdb);

    const ids = {
      imdb: target.externalIds.imdb ?? undefined,
      tvdb: target.externalIds.tvdb ?? undefined,
    };

    const byId = yield* plugin.findByExternalId(target.kind, ids);

    if (byId !== undefined) return Option.some(byId);

    const query = { kind: target.kind, title: target.name, year: target.year ?? undefined, ids };

    return Option.fromUndefinedOr(bestMatch(query, yield* plugin.search(query))?.providerId);
  });

  return {
    kind: "metadata",
    run: Effect.fn("MetadataJob.run")(function* (claim, workerId, reportProgress) {
      const { payload } = claim.job;

      if (payload.kind !== "metadata") {
        return yield* new JobFailed({ message: "This is not a metadata job", retry: false });
      }

      const target = yield* backend
        .call("mediaService.metadataTarget", { titleId: payload.titleId })
        .pipe(Effect.mapError(backendFailure));

      const providerId = yield* providerIdOf(
        target,
        Option.fromNullOr(payload.match).pipe(Option.map((match) => match.providerId)),
      ).pipe(Effect.mapError(providerFailure));

      if (Option.isNone(providerId)) {
        return yield* new JobFailed({
          message: `No metadata match for ${target.name}; choose one with metadata.fixMatch`,
          retry: false,
        });
      }

      const details = yield* plugin
        .titleDetails(target.kind, providerId.value)
        .pipe(Effect.mapError(providerFailure));

      const folder = { libraryId: target.libraryId, root: "" };
      const scanned = yield* toScannedTitle(folder, titleMetadataOf(details), keys.seal);

      const title = {
        ...scanned,
        artwork: {
          poster: scanned.artwork.poster ?? target.artwork.poster,
          backdrop: scanned.artwork.backdrop ?? target.artwork.backdrop,
          logo: scanned.artwork.logo ?? target.artwork.logo,
        },
      };

      const seasons = [...new Set(target.episodes.map((episode) => episode.seasonNumber))];

      const episodes: Array<ScannedEpisode> =
        target.kind === "show"
          ? yield* Effect.forEach(seasons, (season) =>
              plugin.seasonDetails(providerId.value, season).pipe(
                Effect.flatMap((seasonDetails) =>
                  Effect.forEach(
                    target.episodes.filter((episode) => episode.seasonNumber === season),
                    (episode) =>
                      toScannedEpisode(
                        folder,
                        episodeMetadataOf(seasonDetails, episode.episodeNumber),
                        keys.seal,
                      ),
                  ),
                ),
                // A season the provider does not know keeps its local episode details.
                Effect.catchTag("MetadataRequestFailed", () => Effect.succeed([])),
                Effect.mapError(providerFailure),
              ),
            ).pipe(Effect.map((perSeason) => perSeason.flat()))
          : [];

      const batches = Array.from(
        { length: Math.max(1, Math.ceil(episodes.length / EPISODE_BATCH)) },
        (_, index) => episodes.slice(index * EPISODE_BATCH, (index + 1) * EPISODE_BATCH),
      );

      yield* Effect.forEach(
        batches,
        (batch, index) =>
          backend
            .call("mediaService.applyMetadata", {
              jobId: claim.job.id,
              workerId,
              titleId: target.titleId,
              title,
              episodes: batch,
            })
            .pipe(
              Effect.mapError(backendFailure),
              Effect.andThen(
                reportProgress({ done: index + 1, total: batches.length, message: "writing" }),
              ),
            ),
        { discard: true },
      );

      return `Matched to TMDB ${providerId.value}: ${details.title}${details.year === undefined ? "" : ` (${String(details.year)})`}`;
    }),
  } satisfies JobHandler;
});
