/** Remove All Downloads (H18), confirmed like H30: deletes every download of the profile. */
import { Trash2 } from "lucide-react-native";

import { ConfirmSheet } from "@/components/settings/confirm-sheet";
import { useActiveProfile } from "@/session/active-profile";
import { useDownloads } from "@/session/downloads";

export default function RemoveAllDownloads() {
  const { profile } = useActiveProfile();
  const { engine } = useDownloads();

  return (
    <ConfirmSheet
      title="Remove all downloads?"
      description="You can download them again from your server."
      action="Remove All Downloads"
      icon={Trash2}
      onConfirm={() => engine?.removeAll(profile.id) ?? Promise.resolve()}
    />
  );
}
