/**
 * The source's libraries on Review (J02): each one used in place or added, its folders here, and
 * a field for each source folder this server does not have, to say where it is here. Mapping a
 * folder reconnects and runs the dry run again.
 */
import { Folder } from "lucide-react-native";
import { Fragment, useState } from "react";

import { useImportState, useReview } from "@/components/owner/import-state";
import type { Preview } from "@/components/owner/import-state";
import { OwnerScreen } from "@/components/owner/parts";
import { useTask } from "@/components/owner/use-task";
import { Button } from "@/components/ui/button";
import { ListRow } from "@/components/ui/list-row";
import { TextField } from "@/components/ui/text-field";

type Review = ReturnType<typeof useReview>;

function UnmappedFolder({ from, map }: { readonly from: string; readonly map: Review["map"] }) {
  const task = useTask(map);
  const [to, setTo] = useState("");
  const [invalid, setInvalid] = useState(false);

  const submit = async () => {
    const mapped = await task.run(from, to);

    setInvalid(mapped !== null && !mapped.value);
  };

  return (
    <>
      <TextField
        label={from}
        placeholder="Folder on this server"
        value={to}
        onChangeText={(text) => {
          setTo(text);
          setInvalid(false);
        }}
        error={invalid ? "Enter the folder’s full path, starting with /." : task.error}
        autoCapitalize="none"
        keyboardType="url"
        returnKeyType="done"
        onSubmitEditing={() => void submit()}
      />
      <Button
        label="Map Folder"
        variant="secondary"
        busy={task.busy}
        disabled={to.trim() === ""}
        onPress={() => void submit()}
      />
    </>
  );
}

function LibraryList({ preview }: { readonly preview: Preview }) {
  const review = useReview(preview);

  return preview.report.libraries.map((library) => (
    <Fragment key={library.sourceLibraryId}>
      <ListRow
        icon={Folder}
        title={library.name}
        subtitle={library.roots.length === 0 ? undefined : library.roots.join(", ")}
        detail={library.existingLibraryId === null ? "New" : "Already Here"}
      />
      {library.unmappedFolders.map((folder) => (
        <UnmappedFolder key={folder} from={folder} map={review.map} />
      ))}
    </Fragment>
  ));
}

export default function ImportLibraries() {
  const { preview } = useImportState();

  return (
    <OwnerScreen title="Libraries" fallback="/owner/import">
      {preview === null ? null : <LibraryList preview={preview} />}
    </OwnerScreen>
  );
}
