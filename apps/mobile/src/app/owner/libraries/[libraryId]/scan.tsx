/**
 * I06 · Scanning a library: how many files are done, what the scanner is doing, the titles found
 * so far and those that need a match, Keep Browsing, and Cancel Scan. It follows `jobId`, or the
 * library's latest scan, to the end: Done when it finished, and the folder trouble of I05 with
 * Retry Scan when it could not read the folder. During first run, leaving it goes Home (C13).
 */
import { JobId, LibraryId } from "@movies/contracts/ids";
import type { LibraryDetail } from "@movies/contracts/models/catalog";
import type { Job } from "@movies/contracts/models/jobs";
import { useCommand, useCommandQuery } from "@movies/sdk/react";
import { Schema } from "effect";
import { router, useLocalSearchParams } from "expo-router";
import { Clapperboard, RotateCcw, Search } from "lucide-react-native";

import { Loading, Meter, OwnerScreen } from "@/components/owner/parts";
import { useTask } from "@/components/owner/use-task";
import { Button } from "@/components/ui/button";
import { ListRow } from "@/components/ui/list-row";
import { Text } from "@/components/ui/text";
import { formatCount } from "@/lib/owner-format";
import { folderTrouble, isActive, isStopped, scanCount, scanLine } from "@/lib/scans";
import { useFinishSetup } from "@/session/finish-setup";
import { useSessionPhase } from "@/session/session-phase";

const decodeLibraryId = Schema.decodeUnknownSync(LibraryId);

const decodeJobId = Schema.decodeUnknownSync(JobId);

/** The scan named by the route, or the library's latest. */
const useScan = (libraryId: LibraryId, jobId: string | undefined): Job | null | undefined => {
  const named = useCommandQuery(
    "jobs.get",
    jobId === undefined ? "skip" : { jobId: decodeJobId(jobId) },
  );

  const recent = useCommandQuery(
    "jobs.list",
    jobId === undefined ? { kind: "scan", libraryId, limit: 1 } : "skip",
  );

  if (jobId !== undefined) {
    if (named.status === "loading") return undefined;

    return named.status === "success" ? named.data : null;
  }

  if (recent.status === "loading") return undefined;

  return recent.status === "success" ? (recent.data[0] ?? null) : null;
};

/** The line under the count, in the owner's words for a folder the scan could not read. */
const lineFor = (job: Job): string => {
  const trouble = folderTrouble(job);

  if (trouble === "offline") return "The NAS can’t be reached.";

  if (trouble === "notApproved") return "This folder isn’t available to the server.";

  return scanLine(job);
};

const meterLabel = (job: Job): string => {
  const count = scanCount(job);

  if (count !== null) return count.label;

  return job.status === "pending" ? "Starting" : `${formatCount(job.progress.done)} Files`;
};

function ScanView({ library, job }: { readonly library: LibraryDetail; readonly job: Job }) {
  const phase = useSessionPhase();
  const finishSetup = useFinishSetup();
  const cancel = useCommand("jobs.cancel");
  const scan = useCommand("libraries.scan");
  const summary = useCommandQuery("libraries.fileSummary", { libraryId: library.id });
  const active = isActive(job);
  const count = scanCount(job);

  const leave = () => {
    if (phase.kind === "setup") {
      void finishSetup();

      return;
    }

    if (router.canGoBack()) router.back();
    else
      router.replace({
        pathname: "/owner/libraries/[libraryId]",
        params: { libraryId: library.id },
      });
  };

  const stop = useTask(() => cancel({ jobId: job.id }));

  const retry = useTask(async () => {
    const queued = await scan({ libraryId: library.id, mode: "full" });

    router.setParams({ jobId: queued.jobId });
  });

  const unmatched = summary.status === "success" ? summary.data.unmatchedTitles : null;
  const error = stop.error ?? retry.error;

  return (
    <>
      <Meter
        label={meterLabel(job)}
        value={count?.fraction ?? 0}
        accessibilityLabel={`${library.name}: ${meterLabel(job)}`}
      />
      <Text tone="muted" accessibilityLiveRegion="polite">
        {lineFor(job)}
      </Text>
      <ListRow
        icon={Clapperboard}
        title={library.kind === "shows" ? "Shows" : "Titles"}
        detail={formatCount(library.titleCount)}
      />
      <ListRow
        icon={Search}
        title="Needs Review"
        detail={unmatched === null ? undefined : formatCount(unmatched)}
        onPress={
          unmatched === null || unmatched === 0
            ? undefined
            : () =>
                router.push({
                  pathname: "/owner/libraries/[libraryId]/files",
                  params: { libraryId: library.id, filter: "unmatched" },
                })
        }
      />
      {error === null ? null : (
        <Text variant="meta" tone="danger">
          {error}
        </Text>
      )}
      {isStopped(job) ? (
        <>
          <Button
            label="Retry Scan"
            icon={RotateCcw}
            busy={retry.busy}
            onPress={() => void retry.run()}
          />
          {folderTrouble(job) === null ? null : (
            <Button
              label="Edit Folder"
              variant="secondary"
              onPress={() =>
                router.push({
                  pathname: "/owner/libraries/[libraryId]/edit",
                  params: { libraryId: library.id },
                })
              }
            />
          )}
          <Button label="Keep Browsing" variant="plain" onPress={leave} />
        </>
      ) : active ? (
        <>
          <Button label="Keep Browsing" variant="secondary" onPress={leave} />
          <Button
            label="Cancel Scan"
            variant="destructive"
            busy={stop.busy}
            onPress={() => void stop.run()}
          />
        </>
      ) : (
        <Button label="Done" onPress={leave} />
      )}
    </>
  );
}

export default function ScanLibrary() {
  const params = useLocalSearchParams<{ libraryId: string; jobId?: string }>();
  const libraryId = decodeLibraryId(params.libraryId);
  const library = useCommandQuery("libraries.get", { libraryId });
  const job = useScan(libraryId, params.jobId);
  const name = library.status === "success" ? library.data.name : "Library";
  const title = job !== null && job !== undefined && isActive(job) ? `Scanning ${name}` : name;

  return (
    <OwnerScreen title={title} fallback="/owner/libraries">
      {library.status === "success" && job !== undefined && job !== null ? (
        <ScanView library={library.data} job={job} />
      ) : job === null ? (
        <Text tone="muted" className="pt-8">
          No scan to show yet.
        </Text>
      ) : (
        <Loading />
      )}
    </OwnerScreen>
  );
}
