/** B09 · Delete Profile: the sheet that confirms deleting a profile with its history and list. */
import { ProfileId } from "@movies/contracts/ids";
import { useCommand } from "@movies/sdk/react";
import { Schema } from "effect";
import { router, useLocalSearchParams } from "expo-router";
import { Trash2, X } from "lucide-react-native";
import { useState } from "react";
import { Alert, View } from "react-native";

import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Text } from "@/components/ui/text";
import { describeFailure } from "@/lib/failure";
import { useProfileChoice } from "@/session/profile-choice";

const decodeProfileId = Schema.decodeUnknownSync(ProfileId);

export default function DeleteProfile() {
  // The name comes with the route: the sheet keeps it while the profile disappears.
  const params = useLocalSearchParams<{ profileId: string; name: string }>();
  const profileId = decodeProfileId(params.profileId);
  const removeProfile = useCommand("profiles.remove");
  const { profileId: chosen, choose } = useProfileChoice();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async () => {
    setBusy(true);
    setError(null);

    // Deleting the profile in use leaves the app for Who's Watching?: close everything first,
    // since the screens above the tabs outlive the switch.
    if (chosen === profileId) {
      router.dismissAll();

      try {
        await removeProfile({ profileId });
        await choose(null);
      } catch (cause) {
        Alert.alert("Couldn’t Delete Profile", describeFailure(cause));
      }

      return;
    }

    try {
      await removeProfile({ profileId });
      router.dismissTo("/manage-profiles");
    } catch (cause) {
      setError(describeFailure(cause));
      setBusy(false);
    }
  };

  return (
    <View className="gap-4 bg-surface-raised px-5 pt-6 pb-8">
      <View className="flex-row items-center gap-3">
        <Text variant="heading" className="flex-1" accessibilityRole="header">
          {`Delete ${params.name}?`}
        </Text>
        <IconButton icon={X} label="Close" onPress={() => router.back()} />
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
