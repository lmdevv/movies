import type { LibraryId } from "@movies/contracts/ids";
import type { Job } from "@movies/contracts/models/jobs";
import { useCommandQuery } from "@movies/sdk/react";
import { useMemo } from "react";

/** How many recent scan jobs are read to find each library's latest one. */
const RECENT_SCANS = 100;

/** Each library's most recent scan job, live, so rows show progress as the media service reports it. */
export const useLatestScans = (): ReadonlyMap<LibraryId, Job> => {
  const jobs = useCommandQuery("jobs.list", { kind: "scan", limit: RECENT_SCANS });

  return useMemo(() => {
    const latest = new Map<LibraryId, Job>();

    if (jobs.status !== "success") return latest;

    // Jobs arrive newest first, so the first one seen for a library is its latest.
    for (const job of jobs.data) {
      if (job.payload.kind === "scan" && !latest.has(job.payload.libraryId)) {
        latest.set(job.payload.libraryId, job);
      }
    }

    return latest;
  }, [jobs]);
};

/** Whether a job is still queued or running. */
export const isActive = (job: Job | undefined): boolean =>
  job !== undefined && (job.status === "pending" || job.status === "running");

/** The scanner's failure prefixes for an unreachable library folder (see `library-scanner.ts`). */
const UNREACHABLE_PREFIXES = ["Library root unavailable", "Library folder unreadable"] as const;

/** Whether a failed scan could not read the library's folders, such as an offline NAS share. */
export const isUnreachable = (job: Job): boolean =>
  job.status === "failed" &&
  job.error !== null &&
  UNREACHABLE_PREFIXES.some((prefix) => job.error?.startsWith(prefix) === true);
