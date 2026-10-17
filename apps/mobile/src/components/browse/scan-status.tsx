/**
 * The scanning rows at the top of Home while a library scans (C13): which library, how far it is
 * when this session may see scan jobs, and the progress line.
 */
import type { Job } from "@movies/contracts/models/jobs";
import type { Library } from "@movies/contracts/models/catalog";
import { useCommandQuery } from "@movies/sdk/react";
import { Folder } from "lucide-react-native";
import { View } from "react-native";

import { ListRow } from "@/components/ui/list-row";
import { ProgressBar } from "@/components/ui/progress-bar";

/** Recent scan jobs read to find the running ones. */
const JOB_WINDOW = 20;

/** A scan's count and fraction, once the worker knows how many files there are. */
const progressOf = (
  job: Job | undefined,
): { readonly detail: string; readonly value: number } | null => {
  if (job === undefined || job.progress.total === null || job.progress.total <= 0) return null;

  return {
    detail: `${job.progress.done} of ${job.progress.total}`,
    value: Math.min(1, job.progress.done / job.progress.total),
  };
};

/** One row per scanning library, with counts for sessions that manage libraries. */
export function ScanStatus({ libraries }: { readonly libraries: ReadonlyArray<Library> }) {
  const viewer = useCommandQuery("account.viewer", {});
  const manage = viewer.status === "success" && viewer.data.scopes.includes("manage");
  const jobs = useCommandQuery("jobs.list", manage ? { kind: "scan", limit: JOB_WINDOW } : "skip");

  const running =
    jobs.status === "success" ? jobs.data.filter((job) => job.status === "running") : [];

  return (
    <View className="gap-4 px-5">
      {libraries
        .filter((library) => library.scanning)
        .map((library) => {
          const job = running.find(
            (candidate) =>
              candidate.payload.kind === "scan" && candidate.payload.libraryId === library.id,
          );

          const progress = progressOf(job);
          const title = `Scanning ${library.name}`;

          return (
            <View key={library.id} className="gap-4">
              {progress === null ? (
                <ListRow icon={Folder} title={title} />
              ) : (
                <ListRow icon={Folder} title={title} detail={progress.detail} />
              )}
              {progress === null ? null : <ProgressBar value={progress.value} />}
            </View>
          );
        })}
    </View>
  );
}
