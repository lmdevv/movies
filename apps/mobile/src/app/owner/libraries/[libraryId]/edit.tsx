/**
 * Editing a library from I04's Server Folder or I05's Edit Folder: its name and folders, checked as
 * Add Library checks them (I17). Saving changed folders scans the library again.
 */
import { LibraryId } from "@movies/contracts/ids";
import type { LibraryDetail } from "@movies/contracts/models/catalog";
import { useCommand, useCommandQuery } from "@movies/sdk/react";
import { Schema } from "effect";
import { router, useLocalSearchParams } from "expo-router";

import { LibraryForm } from "@/components/owner/library-form";
import { OwnerScreen, QueryView } from "@/components/owner/parts";
import { draftOf, submission } from "@/lib/library-form";

const decodeLibraryId = Schema.decodeUnknownSync(LibraryId);

function EditForm({ library }: { readonly library: LibraryDetail }) {
  const update = useCommand("libraries.update");

  return (
    <LibraryForm
      title={library.name}
      initial={draftOf(library)}
      chooseKind={false}
      submitLabel="Save"
      onSubmit={async (draft) => {
        const { name, roots } = submission(draft);
        const moved = roots.join("\n") !== library.roots.join("\n");

        // New folders scan again; a rename alone does not.
        await update(
          moved ? { libraryId: library.id, name, roots } : { libraryId: library.id, name },
        );

        if (moved) {
          // The update queued a scan of the new folders; the scan screen follows the latest.
          router.replace({
            pathname: "/owner/libraries/[libraryId]/scan",
            params: { libraryId: library.id },
          });

          return;
        }

        router.back();
      }}
    />
  );
}

export default function EditLibrary() {
  const params = useLocalSearchParams<{ libraryId: string }>();

  const library = useCommandQuery("libraries.get", {
    libraryId: decodeLibraryId(params.libraryId),
  });

  if (library.status === "success") return <EditForm library={library.data} />;

  return (
    <OwnerScreen title="Library">
      <QueryView query={library}>{() => null}</QueryView>
    </OwnerScreen>
  );
}
