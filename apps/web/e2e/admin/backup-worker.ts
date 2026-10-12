/**
 * Stands in for backups in browser tests, which the media service does not run yet: it signs in
 * with the stack's media service key and calls the same `mediaService:*` functions a backup worker
 * would, so the Backups screen sees a real job finish with a real archive.
 */
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import type { Value } from "convex/values";
import { Schema } from "effect";

import type { StackEnv } from "../stack/stack-env";
import { openClient } from "./session";

type Args = Readonly<Record<string, Value>>;

const WORKER_ID = "e2e-backup-worker";

const LEASE_MS = 600_000;

const decodeSession = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ token: Schema.String })),
);

/** Runs one backup job: claims it, records its archive, and completes it. */
export type RunBackup = (jobId: string, fileName: string, sizeBytes: number) => Promise<void>;

/** Signs in as the media service and returns the way to run backup jobs. */
export const openBackupWorker = async (stack: StackEnv): Promise<RunBackup> => {
  const service = openClient(stack);

  await service.sdk.auth.signInWithApiKey(stack.mediaServiceKey);

  const { token } = decodeSession(service.session());
  const http = new ConvexHttpClient(stack.convexUrl, { logger: false });

  http.setAuth(token);

  const mutate = async (path: `mediaService:${string}`, args: Args): Promise<void> => {
    await http.mutation(makeFunctionReference<"mutation", Args, Value>(path), args);
  };

  return async (jobId, fileName, sizeBytes) => {
    await mutate("mediaService:claimJob", { jobId, workerId: WORKER_ID, leaseMs: LEASE_MS });
    await mutate("mediaService:recordBackup", { jobId, workerId: WORKER_ID, fileName, sizeBytes });
    await mutate("mediaService:completeJob", { jobId, workerId: WORKER_ID });
  };
};
