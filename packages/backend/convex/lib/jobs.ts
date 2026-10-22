import type { Infer } from "convex/values";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { fail } from "./errors";
import type { jobPayload } from "./validators";
import type { ReadCtx } from "./viewer";

/** Attempts before a job whose worker keeps disappearing fails for good. */
export const MAX_JOB_ATTEMPTS = 5;

const EMPTY_PROGRESS = { done: 0, total: null, message: null };

/**
 * Queues a job. A scan of a library that already has a scan queued or running returns that one,
 * and so does a backup while another backup is queued or running.
 */
export const enqueueJob = async (
  ctx: MutationCtx,
  payload: Infer<typeof jobPayload>,
  requestedBy: Id<"users"> | null,
): Promise<Id<"jobs">> => {
  if (payload.kind === "scan" || payload.kind === "backup") {
    const active = await Promise.all(
      (["pending", "running"] as const).map((status) =>
        ctx.db
          .query("jobs")
          .withIndex("by_kind_status", (q) => q.eq("kind", payload.kind).eq("status", status))
          .collect(),
      ),
    );

    const duplicate = active
      .flat()
      .find(
        (job) =>
          payload.kind === "backup" ||
          (job.payload.kind === "scan" && job.payload.libraryId === payload.libraryId),
      );

    if (duplicate !== undefined) return duplicate._id;
  }

  const job = {
    kind: payload.kind,
    status: "pending" as const,
    payload,
    progress: EMPTY_PROGRESS,
    error: null,
    requestedBy,
    attempts: 0,
    startedAt: null,
    finishedAt: null,
  };

  if (payload.kind === "scan")
    return ctx.db.insert("jobs", { ...job, libraryId: payload.libraryId });

  if (payload.kind === "trickplay")
    return ctx.db.insert("jobs", { ...job, fileId: payload.fileId });

  return ctx.db.insert("jobs", job);
};

/**
 * Loads a job the worker holds, failing with `conflict` when it lost the lease (another worker
 * claimed it, or the lease expired and the job went back to the queue) or `not_found`.
 */
export const requireLease = async (
  ctx: ReadCtx,
  jobId: Id<"jobs">,
  workerId: string,
): Promise<Doc<"jobs">> => {
  const job = await ctx.db.get(jobId);

  if (job === null) return fail("not_found", "No such job");

  if (job.status !== "running" || job.leaseOwner !== workerId) {
    return fail("conflict", "This worker no longer holds the job's lease");
  }

  return job;
};

/** Loads a held job of one kind; a job of another kind fails with `invalid_args`. */
export const requireLeaseOf = async <Kind extends Doc<"jobs">["kind"]>(
  ctx: ReadCtx,
  jobId: Id<"jobs">,
  workerId: string,
  kind: Kind,
): Promise<Doc<"jobs"> & { readonly payload: Extract<Doc<"jobs">["payload"], { kind: Kind }> }> => {
  const job = await requireLease(ctx, jobId, workerId);
  const { payload } = job;

  if (!isPayloadOf(payload, kind)) return fail("invalid_args", `This job is not a ${kind} job`);

  return { ...job, payload };
};

const isPayloadOf = <Kind extends Doc<"jobs">["kind"]>(
  payload: Doc<"jobs">["payload"],
  kind: Kind,
): payload is Extract<Doc<"jobs">["payload"], { kind: Kind }> => payload.kind === kind;

/** Whether a scan of the library is queued or running. */
export const isLibraryScanning = async (
  ctx: ReadCtx,
  libraryId: Id<"libraries">,
): Promise<boolean> => {
  const active = await Promise.all(
    (["pending", "running"] as const).map((status) =>
      ctx.db
        .query("jobs")
        .withIndex("by_library_status", (q) => q.eq("libraryId", libraryId).eq("status", status))
        .first(),
    ),
  );

  return active.some((job) => job !== null);
};
