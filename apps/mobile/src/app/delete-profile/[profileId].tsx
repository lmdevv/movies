/** B09 · Delete Profile: the sheet that confirms deleting a profile with its history and list. */
import { useCommand } from "@movies/sdk/react";
import { router, useLocalSearchParams } from "expo-router";
import { Trash2, X } from "lucide-react-native";
import { useState } from "react";
import { View } from "react-native";

import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Text } from "@/components/ui/text";
import { describeFailure } from "@/lib/failure";
import { useAccountProfiles } from "@/session/account-profiles";
import { useProfileChoice } from "@/session/profile-choice";

export default function DeleteProfile() {
  const { profileId } = useLocalSearchParams<{ profileId: string }>();
  const profiles = useAccountProfiles();
  const removeProfile = useCommand("profiles.remove");
  const { profileId: chosen, choose } = useProfileChoice();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const profile = profiles.find((candidate) => candidate.id === profileId);

  if (profile === undefined) return null;

  const remove = async () => {
    setBusy(true);
    setError(null);

    try {
      await removeProfile({ profileId: profile.id });

      // Deleting the profile in use goes back to Who's Watching?.
      if (chosen === profile.id) await choose(null);
      else router.dismissTo("/manage-profiles");
    } catch (cause) {
      setError(describeFailure(cause));
      setBusy(false);
    }
  };

  return (
    <View className="gap-4 bg-surface-raised px-5 pt-6 pb-8">
      <View className="flex-row items-center gap-3">
        <Text variant="heading" className="flex-1" accessibilityRole="header">
          {`Delete ${profile.name}?`}
        </Text>
        <IconButton icon={X} label="Close" size="regular" onPress={() => router.back()} />
      </View>
      <Text variant="secondary" tone="muted">
        Their watch history and list will be removed.
      </Text>
      {error === null ? null : (
        <Text variant="meta" tone="danger">
          {error}
        </Text>
      )}
      <Button
        label="Delete Profile"
        variant="destructive"
        icon={Trash2}
        busy={busy}
        onPress={() => void remove()}
      />
      <Button label="Cancel" variant="plain" onPress={() => router.back()} />
    </View>
  );
}
