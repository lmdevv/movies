/**
 * I03 · Add Library, and I17 when the server cannot read the folder: the name, Movies or Shows,
 * and the folder typed or browsed. Add & Scan saves it and follows its first scan (I06).
 */
import { useCommand } from "@movies/sdk/react";
import { router } from "expo-router";

import { LibraryForm } from "@/components/owner/library-form";
import { NEW_DRAFT, submission } from "@/lib/library-form";

export default function AddLibrary() {
  const create = useCommand("libraries.create");

  return (
    <LibraryForm
      title="Add Library"
      initial={NEW_DRAFT}
      chooseKind
      submitLabel="Add & Scan"
      onSubmit={async (draft) => {
        const created = await create({ ...submission(draft), kind: draft.kind });

        router.replace({
          pathname: "/owner/libraries/[libraryId]/scan",
          params: { libraryId: created.libraryId, jobId: created.jobId },
        });
      }}
    />
  );
}
