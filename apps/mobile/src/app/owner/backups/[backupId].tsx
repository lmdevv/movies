/**
 * I12 · Restore Backup: the sheet that confirms replacing the library database with a backup.
 * Restoring ends every session, this one included, so it signs out here once the server is done.
 */
import { BackupId } from "@movies/contracts/ids";
import { useCommand } from "@movies/sdk/react";
import { Schema } from "effect";
import { useLocalSearchParams } from "expo-router";
import { RotateCcw } from "lucide-react-native";

import { useTask } from "@/components/owner/use-task";
import { Sheet, useSheetExit } from "@/components/title/sheet";
import { Button } from "@/components/ui/button";
import { useSignOut } from "@/session/viewer";

const decodeBackupId = Schema.decodeUnknownSync(BackupId);

export default function RestoreBackup() {
  const params = useLocalSearchParams<{ backupId: string }>();
  const backupId = decodeBackupId(params.backupId);
  const restore = useCommand("backups.restore");
  const signOut = useSignOut();
  const exit = useSheetExit();

  const confirm = useTask(async () => {
    await restore({ backupId });
    await signOut();
  });

  return (
    <Sheet
      title="Restore this backup?"
      subtitle="The library database will be replaced. Everyone will need to sign in again."
      error={confirm.error}
      exit={exit}
    >
      <Button
        label="Restore Backup"
        variant="destructive"
        icon={RotateCcw}
        busy={confirm.busy}
        onPress={() => void confirm.run()}
      />
      <Button label="Cancel" variant="plain" onPress={exit.close} />
    </Sheet>
  );
}
