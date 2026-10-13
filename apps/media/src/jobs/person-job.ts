/**
 * Person jobs: someone opened a person whose biography nobody fetched yet (`people.requestDetails`).
 * The job looks the person up at the metadata provider by their TMDB ID and writes their
 * biography, dates, birthplace, department, and photo with `mediaService:applyPerson`.
 */
import type { ScannedPersonDetails } from "@movies/contracts/models/scan";
import { Effect, Match } from "effect";

import type { ArtworkKey } from "@movies/contracts/artwork";
import { ArtworkSource } from "../artwork/artwork-keys.ts";
import * as ArtworkKeys from "../artwork/artwork-keys.ts";
import * as MediaBackend from "../convex/media-backend.ts";
import * as MetadataPlugin from "../metadata/metadata-plugin.ts";
import type { ProviderPerson } from "../metadata/metadata-plugin.ts";
import { JobFailed, type JobHandler } from "./job-worker.ts";

const providerFailure = Match.type<MetadataPlugin.MetadataError>().pipe(
  Match.tagsExhaustive({
    MetadataProviderUnavailable: (error) => new JobFailed({ message: error.message, retry: false }),
    MetadataRequestFailed: (error) =>
      // TMDB answers 404 for a person it no longer has; asking again will not help.
      new JobFailed({ message: error.message, retry: error.status !== 404 }),
    PluginPermissionDenied: (error) => new JobFailed({ message: error.message, retry: false }),
  }),
);

/** Convex failures return the job to the queue. */
const backendFailure = (error: { readonly message: string }) =>
  new JobFailed({ message: error.message, retry: true });

/** The catalog record of a provider's person, with their photo sealed as an artwork key. */
export const personDetailsOf = Effect.fnUntraced(function* (
  person: ProviderPerson,
  seal: (source: ArtworkSource) => Effect.Effect<ArtworkKey>,
) {
  return {
    name: person.name,
    externalIds: {
      tmdb: person.ids.tmdb ?? null,
      imdb: person.ids.imdb ?? null,
      tvdb: person.ids.tvdb ?? null,
    },
    profile:
      person.profile === undefined
        ? null
        : yield* seal(ArtworkSource.Remote({ url: person.profile })),
    biography: person.biography ?? null,
    birthDate: person.birthDate ?? null,
    deathDate: person.deathDate ?? null,
    birthPlace: person.birthPlace ?? null,
    knownFor: person.knownFor ?? null,
  } satisfies ScannedPersonDetails;
});

/** The person job handler. */
export const handler: Effect.Effect<
  JobHandler,
  never,
  MediaBackend.Service | MetadataPlugin.Service | ArtworkKeys.Service
> = Effect.gen(function* () {
  const backend = yield* MediaBackend.Service;
  const plugin = yield* MetadataPlugin.Service;
  const keys = yield* ArtworkKeys.Service;

  return {
    kind: "person",
    run: Effect.fn("PersonJob.run")(function* (claim, workerId) {
      const { payload } = claim.job;

      if (payload.kind !== "person") {
        return yield* new JobFailed({ message: "This is not a person job", retry: false });
      }

      const target = yield* backend
        .call("mediaService.personTarget", { personId: payload.personId })
        .pipe(Effect.mapError(backendFailure));

      if (target.externalIds.tmdb === null) {
        return yield* new JobFailed({
          message: `${target.name} has no TMDB ID to look up`,
          retry: false,
        });
      }

      const found = yield* plugin
        .personDetails(target.externalIds.tmdb)
        .pipe(Effect.mapError(providerFailure));

      yield* backend
        .call("mediaService.applyPerson", {
          jobId: claim.job.id,
          workerId,
          personId: payload.personId,
          details: yield* personDetailsOf(found, keys.seal),
        })
        .pipe(Effect.mapError(backendFailure));

      return `Fetched details of ${found.name}`;
    }),
  } satisfies JobHandler;
});
