/**
 * A stand-in for the media service's scan worker, for end-to-end tests: it signs in with the
 * stack's media service key and claims, reports, writes, completes, or fails scan jobs through the
 * same `mediaService:*` functions the real service calls. The web app sees real jobs and titles.
 */
import type { JobId, LibraryId } from "@movies/contracts/ids";
import { mediaServiceFunctions } from "@movies/contracts/media-service";
import type { ScannedItem } from "@movies/contracts/models/scan";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { Schema } from "effect";

import type { StackEnv } from "./stack-env";

type Functions = typeof mediaServiceFunctions;

type Name = keyof Functions;

const Tokens = Schema.Struct({
  tokens: Schema.optionalKey(Schema.NullOr(Schema.Struct({ token: Schema.String }))),
});

const WireArgs = Schema.Record(Schema.String, Schema.Unknown);

/** A signed-in connection as the media service. */
export interface MediaWorker {
  readonly call: <N extends Name>(
    name: N,
    args: Functions[N]["args"]["Type"],
  ) => Promise<Functions[N]["result"]["Type"]>;
}

/** Signs in as the media service. */
export const connectMediaWorker = async (stack: StackEnv): Promise<MediaWorker> => {
  const anonymous = new ConvexHttpClient(stack.convexUrl, { logger: false });

  const signedIn = Schema.decodeUnknownSync(Tokens)(
    await anonymous.action(makeFunctionReference<"action">("auth:signIn"), {
      provider: "apikey",
      params: { key: stack.mediaServiceKey },
    }),
  );

  const token = signedIn.tokens?.token;

  if (token === undefined) throw new Error("The media service key was refused");

  const client = new ConvexHttpClient(stack.convexUrl, { logger: false });

  client.setAuth(token);

  return {
    call: async (name, args) => {
      const fn = mediaServiceFunctions[name];
      const wire = Schema.decodeSync(WireArgs)(Schema.encodeUnknownSync(fn.args)(args));

      const raw: unknown =
        fn.kind === "query"
          ? await client.query(makeFunctionReference<"query">(fn.function), wire)
          : await client.mutation(makeFunctionReference<"mutation">(fn.function), wire);

      return Schema.decodeUnknownSync(fn.result)(raw);
    },
  };
};

const WORKER_ID = "e2e-worker";

const LEASE_MS = 60_000;

/** A scan job this worker holds. */
export interface ClaimedScan {
  readonly jobId: JobId;
  readonly libraryId: LibraryId;
  readonly roots: ReadonlyArray<string>;
}

/** Waits for a pending scan job and claims it. */
export const claimNextScan = async (
  worker: MediaWorker,
  timeoutMs = 15_000,
): Promise<ClaimedScan> => {
  const deadline = Date.now() + timeoutMs;

  const attempt = async (): Promise<ClaimedScan> => {
    const pending = await worker.call("mediaService.pendingJobs", {});
    const job = pending.find((candidate) => candidate.payload.kind === "scan");

    const claim =
      job === undefined
        ? null
        : await worker.call("mediaService.claimJob", {
            jobId: job.id,
            workerId: WORKER_ID,
            leaseMs: LEASE_MS,
          });

    if (claim !== null && claim.library !== null) {
      return { jobId: claim.job.id, libraryId: claim.library.id, roots: claim.library.roots };
    }

    if (Date.now() > deadline) throw new Error("No scan job appeared");

    await new Promise((resolve) => setTimeout(resolve, 250));

    return attempt();
  };

  return attempt();
};

/** Reports progress on a claimed scan. */
export const reportScan = (
  worker: MediaWorker,
  jobId: JobId,
  done: number,
  total: number,
  message: string | null,
) =>
  worker.call("mediaService.renewLease", {
    jobId,
    workerId: WORKER_ID,
    leaseMs: LEASE_MS,
    progress: { done, total, message },
  });

/** Writes `items` into the library and finishes the scan. */
export const completeScan = async (
  worker: MediaWorker,
  claimed: ClaimedScan,
  items: ReadonlyArray<ScannedItem>,
): Promise<void> => {
  const { jobId, libraryId } = claimed;

  // The fixture catalog fits in one batch of at most 100 items.
  await worker.call("mediaService.upsertScanned", { libraryId, items });

  await worker.call("mediaService.renewLease", {
    jobId,
    workerId: WORKER_ID,
    leaseMs: LEASE_MS,
    progress: { done: items.length, total: items.length, message: null },
  });

  await worker.call("mediaService.completeJob", { jobId, workerId: WORKER_ID });
};

/** Fails a claimed scan for good with `error`. */
export const failScan = async (worker: MediaWorker, jobId: JobId, error: string): Promise<void> => {
  await worker.call("mediaService.failJob", {
    jobId,
    workerId: WORKER_ID,
    error,
    retry: false,
  });
};
