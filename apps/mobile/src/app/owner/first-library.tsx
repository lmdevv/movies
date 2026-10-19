/**
 * I15 · Add Your First Library: first run's second step, after the owner account, and the screen
 * the owner stack opens on during first run. Add & Scan
 * follows the first scan (I06), from which Keep Browsing goes Home while it runs; Set Up Later
 * goes Home now. Owner setup that began with Import from Jellyfin or Plex opens the import over
 * this screen, so backing out of it lands here.
 */
import { useCommand } from "@movies/sdk/react";
import { router } from "expo-router";
import { useEffect } from "react";

import { LibraryForm } from "@/components/owner/library-form";
import { useTask } from "@/components/owner/use-task";
import { Button } from "@/components/ui/button";
import { NEW_DRAFT, submission } from "@/lib/library-form";
import { useFinishSetup } from "@/session/finish-setup";
import { useFirstRun } from "@/session/first-run";
import { useSessionPhase } from "@/session/session-phase";

export default function AddYourFirstLibrary() {
  const create = useCommand("libraries.create");
  const firstRun = useFirstRun();
  const finishSetup = useFinishSetup();
  const phase = useSessionPhase();

  // Outside first run (opened from a link) there is no setup to finish; going back is the same.
  const later = useTask(async () => {
    if (phase.kind === "setup") await finishSetup();
    else router.back();
  });

  const { start, startedImport } = firstRun;

  useEffect(() => {
    if (start !== "import") return;
    startedImport();
    router.push("/owner/import");
  }, [start, startedImport]);

  return (
    <LibraryForm
      title="Add Your First Library"
      initial={NEW_DRAFT}
      chooseKind
      submitLabel="Add & Scan"
      checkButton={false}
      back={false}
      onSubmit={async (draft) => {
        const created = await create({ ...submission(draft), kind: draft.kind });

        router.push({
          pathname: "/owner/libraries/[libraryId]/scan",
          params: { libraryId: created.libraryId, jobId: created.jobId },
        });
      }}
      secondary={
        <Button
          label="Set Up Later"
          variant="secondary"
          busy={later.busy}
          onPress={() => void later.run()}
        />
      }
    />
  );
}
