/**
 * Scrub thumbnails per file. A scan that finds a file new or changed queues a `trickplay` job for
 * it (when its library allows); the media service makes the sprite sheets and records them with
 * `mediaService:recordTrickplay`. A file's `trickplay` field follows its job: `pending` while one
 * is queued or running (with the size and modification time it was queued for), `ready` with the
 * manifest players read, `failed` once the job gave up, and absent when none was asked for or the
 * job was cancelled. A changed file (another size or modification time) is queued again, replacing
 * a job queued for its old contents; a failed one only when an admin asks.
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { enqueueJob } from "./jobs";

/** Whether `file` can have thumbnails: present, with video and a known length. */
const hasFrames = (file: Doc<"mediaFiles">): boolean =>
  !file.missing && file.probe.video.length > 0 && file.probe.durationMs > 0;

/** Whether `file`'s recorded state (thumbnails, a failure, a queued job) is for its contents now. */
export const forCurrent = (file: Doc<"mediaFiles">): boolean =>
  file.trickplay !== undefined &&
  file.trickplay.sizeBytes === file.sizeBytes &&
  file.trickplay.mtimeMs === file.mtimeMs;

/** The job of `file`'s pending state while it is still queued or running. */
const activeJob = async (
  ctx: MutationCtx,
  file: Doc<"mediaFiles">,
): Promise<Doc<"jobs"> | null> => {
  if (file.trickplay?.status !== "pending") return null;
  const job = await ctx.db.get(file.trickplay.jobId);

  return job !== null && (job.status === "pending" || job.status === "running") ? job : null;
};

/**
 * Cancels `file`'s queued or running trickplay job, if any; a running worker sees it on its next
 * lease renewal and stops.
 */
const cancelJobOf = async (ctx: MutationCtx, file: Doc<"mediaFiles">): Promise<void> => {
  const job = await activeJob(ctx, file);

  if (job !== null) await ctx.db.patch(job._id, { status: "cancelled", finishedAt: Date.now() });
};

/**
 * Queues a trickplay job for `file` unless it has no frames, already has one queued for its
 * current contents, or has thumbnails of them. A job queued for older contents is cancelled and
 * replaced. `retryFailed` also queues files whose last job failed for their current contents, as
 * when an admin asks for thumbnails. Returns whether it queued one.
 */
export const queueTrickplay = async (
  ctx: MutationCtx,
  file: Doc<"mediaFiles">,
  options: { readonly retryFailed: boolean; readonly requestedBy: Id<"users"> | null },
): Promise<boolean> => {
  if (!hasFrames(file)) return false;
  const active = await activeJob(ctx, file);

  if (active !== null && forCurrent(file)) return false;

  const settled =
    active === null && forCurrent(file) && file.trickplay?.status !== "pending"
      ? file.trickplay?.status
      : undefined;

  if (settled === "ready" || (settled === "failed" && !options.retryFailed)) return false;

  await cancelJobOf(ctx, file);

  const jobId = await enqueueJob(ctx, { kind: "trickplay", fileId: file._id }, options.requestedBy);

  await ctx.db.patch(file._id, {
    trickplay: { status: "pending", jobId, sizeBytes: file.sizeBytes, mtimeMs: file.mtimeMs },
  });

  return true;
};

/** The manifest players may use: thumbnails made from the file's contents now, or none. */
export const currentManifest = (file: Doc<"mediaFiles">) =>
  file.trickplay?.status === "ready" && forCurrent(file) ? file.trickplay.manifest : null;

/**
 * Forgets `file`'s thumbnails and cancels its job, as when the file goes missing or its library
 * stops making thumbnails. The media service's sweep deletes the sheets.
 */
export const forgetTrickplay = async (ctx: MutationCtx, file: Doc<"mediaFiles">): Promise<void> => {
  await cancelJobOf(ctx, file);

  if (file.trickplay !== undefined) await ctx.db.patch(file._id, { trickplay: undefined });
};

/**
 * Settles the file of a trickplay job that ended without thumbnails: `failed` keeps a failure for
 * the contents the job was queued for, so scans do not queue those again; `cancelled` clears the
 * state. Files whose state moved on (a newer job, a missing file) are left alone.
 */
export const settleTrickplay = async (
  ctx: MutationCtx,
  job: Doc<"jobs">,
  outcome: "failed" | "cancelled",
): Promise<void> => {
  if (job.payload.kind !== "trickplay") return;
  const file = await ctx.db.get(job.payload.fileId);
  const state = file?.trickplay;

  if (file === null || state?.status !== "pending" || state.jobId !== job._id) return;

  await ctx.db.patch(file._id, {
    trickplay:
      outcome === "failed"
        ? { status: "failed", sizeBytes: state.sizeBytes, mtimeMs: state.mtimeMs }
        : undefined,
  });
};
