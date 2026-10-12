/**
 * Stands in for the media service's job worker in browser tests: it signs in with the stack's
 * media service key and calls the same `mediaService:*` functions the worker calls, so admin
 * screens see real jobs, progress, files, missing files, backups, and failures.
 */
import { ConvexHttpClient } from "convex/browser";
import { Schema } from "effect";
import { makeFunctionReference } from "convex/server";
import type { Value } from "convex/values";

import { mediaServiceKey, openClient } from "./stack";
import type { Stack } from "./stack";

type Args = Readonly<Record<string, Value>>;

const WORKER_ID = "e2e-worker";

const decodeSession = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ token: Schema.String })),
);

const LEASE_MS = 600_000;

const lease = (jobId: string) => ({ jobId, workerId: WORKER_ID, leaseMs: LEASE_MS });

/** One scanned movie file, as the scanner reports it. */
export const movieFile = (path: string, name: string, year: number): Value => ({
  file: {
    path,
    sizeBytes: 9_800_000_000,
    mtimeMs: 1_760_000_000_000,
    probe: {
      container: "matroska",
      durationMs: 6_964_000,
      bitRate: 11_000_000,
      video: [
        {
          index: 0,
          codec: "hevc",
          profile: "Main 10",
          width: 3840,
          height: 2160,
          frameRate: 23.976,
          bitDepth: 10,
          pixelFormat: "yuv420p10le",
          hdr: "hdr10",
          bitRate: null,
        },
      ],
      audio: [],
      subtitles: [],
    },
    externalSubtitles: [],
    versionName: null,
  },
  title: {
    kind: "movie",
    matchKey: `local:${name.toLowerCase()} (${year})`,
    name,
    sortName: null,
    year,
    overview: null,
    tagline: null,
    genres: [],
    certification: null,
    ageRating: null,
    runtimeMs: 6_960_000,
    artwork: { poster: null, backdrop: null, logo: null },
    externalIds: { tmdb: null, imdb: null, tvdb: null },
    matchStatus: "unmatched",
  },
  episode: null,
});

/** The job worker's side of the stack. */
export interface MediaWorker {
  readonly claim: (jobId: string) => Promise<void>;
  readonly progress: (jobId: string, done: number, total: number, message: string) => Promise<void>;
  readonly complete: (jobId: string) => Promise<void>;
  readonly fail: (jobId: string, error: string) => Promise<void>;
  readonly upsert: (libraryId: string, items: ReadonlyArray<Value>) => Promise<void>;
  readonly markMissing: (libraryId: string, paths: ReadonlyArray<string>) => Promise<void>;
  readonly recordBackup: (jobId: string, fileName: string, sizeBytes: number) => Promise<void>;
}

/** Signs in as the media service. */
export const openMediaWorker = async (target: Stack): Promise<MediaWorker> => {
  const service = openClient(target);

  await service.sdk.auth.signInWithApiKey(mediaServiceKey());

  const { token } = decodeSession(service.session());

  const http = new ConvexHttpClient(target.convexUrl, { logger: false });

  http.setAuth(token);

  const mutate = async (path: `mediaService:${string}`, args: Args): Promise<void> => {
    await http.mutation(makeFunctionReference<"mutation", Args, Value>(path), args);
  };

  return {
    claim: (jobId) => mutate("mediaService:claimJob", lease(jobId)),
    progress: (jobId, done, total, message) =>
      mutate("mediaService:renewLease", { ...lease(jobId), progress: { done, total, message } }),
    complete: (jobId) => mutate("mediaService:completeJob", { jobId, workerId: WORKER_ID }),
    fail: (jobId, error) =>
      mutate("mediaService:failJob", { jobId, workerId: WORKER_ID, error, retry: false }),
    upsert: (libraryId, items) =>
      mutate("mediaService:upsertScanned", { libraryId, items: [...items] }),
    markMissing: (libraryId, paths) =>
      mutate("mediaService:markMissing", { libraryId, paths: [...paths] }),
    recordBackup: (jobId, fileName, sizeBytes) =>
      mutate("mediaService:recordBackup", { jobId, workerId: WORKER_ID, fileName, sizeBytes }),
  };
};
