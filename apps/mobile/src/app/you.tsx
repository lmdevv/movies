/**
 * You (placeholder): the profile on screen, switching profiles, and signing out. The You and
 * settings screens (H01–H31) replace this.
 */
import { useState } from "react";
import { Alert, View } from "react-native";

import { ProfileAvatar } from "@/components/profile-avatar";
import { Button } from "@/components/ui/button";
import { NavHeader } from "@/components/ui/nav-header";
import { Screen } from "@/components/ui/screen";
import { Text } from "@/components/ui/text";
import { describeFailure } from "@/lib/failure";
import { useActiveProfile } from "@/session/active-profile";
import { useProfileChoice } from "@/session/profile-choice";
import { useSignOut } from "@/session/viewer";

export default function You() {
  const { profile } = useActiveProfile();
  const { choose } = useProfileChoice();
  const signOut = useSignOut();
  const [busy, setBusy] = useState<"switch" | "signOut" | null>(null);

  const run = async (action: "switch" | "signOut", work: () => Promise<void>) => {
    setBusy(action);

    try {
      await work();
    } catch (cause) {
      Alert.alert(
        action === "switch" ? "Couldn't Switch" : "Couldn't Sign Out",
        describeFailure(cause),
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <Screen header={<NavHeader title="You" />} contentClassName="gap-8 px-5 pt-6">
      <View className="items-center gap-3">
        <ProfileAvatar profile={profile} />
        <Text variant="title" accessibilityRole="header">
          {profile.name}
        </Text>
      </View>
      <View className="gap-3">
        <Button
          label="Switch Profile"
          variant="secondary"
          busy={busy === "switch"}
          disabled={busy !== null}
          onPress={() => void run("switch", () => choose(null))}
        />
        <Button
          label="Sign Out"
          variant="destructive"
          busy={busy === "signOut"}
          disabled={busy !== null}
          onPress={() => void run("signOut", signOut)}
        />
      </View>
    </Screen>
  );
}
