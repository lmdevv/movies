/**
 * Scrub thumbnails per file. A scan that finds a file new or changed queues a `trickplay` job for
 * it (when its library allows); the media service makes the sprite sheets and records them with
 * `mediaService:recordTrickplay`. A file's `trickplay` field follows its job: `pending` while one
 * is queued or running, `ready` with the manifest players read, `failed` once the job gave up, and
 * absent when none was asked for or the job was cancelled. A changed file (another size or
 * modification time) is queued again; a failed one only when an admin asks.
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { enqueueJob } from "./jobs";

/** Whether `file` can have thumbnails: present, with video and a known length. */
const hasFrames = (file: Doc<"mediaFiles">): boolean =>
  !file.missing && file.probe.video.length > 0 && file.probe.durationMs > 0;

/** Whether `file`'s recorded thumbnails (or failure) were made from its current contents. */
const madeFromCurrent = (file: Doc<"mediaFiles">): boolean =>
  file.trickplay !== undefined &&
  file.trickplay.status !== "pending" &&
  file.trickplay.sizeBytes === file.sizeBytes &&
  file.trickplay.mtimeMs === file.mtimeMs;

/** Whether `file` has a trickplay job that is still queued or running. */
const hasActiveJob = async (ctx: MutationCtx, file: Doc<"mediaFiles">): Promise<boolean> => {
  if (file.trickplay?.status !== "pending") return false;
  const job = await ctx.db.get(file.trickplay.jobId);

  return job !== null && (job.status === "pending" || job.status === "running");
};

/**
 * Queues a trickplay job for `file` unless it has no frames, already has one queued, or has
 * thumbnails of its current contents. `retryFailed` also queues files whose last job failed for
 * their current contents, as when an admin asks for thumbnails. Returns whether it queued one.
 */
export const queueTrickplay = async (
  ctx: MutationCtx,
  file: Doc<"mediaFiles">,
  options: { readonly retryFailed: boolean; readonly requestedBy: Id<"users"> | null },
): Promise<boolean> => {
  if (!hasFrames(file) || (await hasActiveJob(ctx, file))) return false;

  if (madeFromCurrent(file) && (file.trickplay?.status === "ready" || !options.retryFailed)) {
    return false;
  }

  const jobId = await enqueueJob(ctx, { kind: "trickplay", fileId: file._id }, options.requestedBy);

  await ctx.db.patch(file._id, { trickplay: { status: "pending", jobId } });

  return true;
};

/**
 * Settles the file of a trickplay job that ended without thumbnails: `failed` keeps a failure for
 * the file's current contents, so scans do not queue it again; `cancelled` clears the state.
 * Files whose state moved on (a newer job, a missing file) are left alone.
 */
export const settleTrickplay = async (
  ctx: MutationCtx,
  job: Doc<"jobs">,
  outcome: "failed" | "cancelled",
): Promise<void> => {
  if (job.payload.kind !== "trickplay") return;
  const file = await ctx.db.get(job.payload.fileId);

  if (file?.trickplay?.status !== "pending" || file.trickplay.jobId !== job._id) return;

  await ctx.db.patch(file._id, {
    trickplay:
      outcome === "failed"
        ? { status: "failed", sizeBytes: file.sizeBytes, mtimeMs: file.mtimeMs }
        : undefined,
  });
};
