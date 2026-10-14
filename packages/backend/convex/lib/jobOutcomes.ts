/**
 * How a job attempt ends when it does not complete. Both the worker reporting a failure and the
 * lease sweep finding a silent worker go through `failAttempt`, so a failed job always leaves the
 * same fields and settles a trickplay job's file the same way.
 */
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { MAX_JOB_ATTEMPTS } from "./jobs";
import { settleTrickplay } from "./trickplay";

/**
 * Ends a job's current attempt without success. It returns to the queue when `retry` allows and
 * attempts remain; otherwise it fails for good and a trickplay job's file records the failure.
 */
export const failAttempt = async (
  ctx: MutationCtx,
  job: Doc<"jobs">,
  failure: { readonly error: string; readonly retry: boolean },
): Promise<void> => {
  const again = failure.retry && job.attempts < MAX_JOB_ATTEMPTS;

  await ctx.db.patch(job._id, {
    status: again ? "pending" : "failed",
    error: failure.error,
    leaseOwner: undefined,
    leaseExpiresAt: undefined,
    finishedAt: again ? null : Date.now(),
  });

  if (!again) await settleTrickplay(ctx, job, "failed");
};
