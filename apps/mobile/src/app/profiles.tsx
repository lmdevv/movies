/** B01 · Who's Watching?: choose a profile; profiles with a PIN ask for it first. */
import type { Profile } from "@movies/contracts/models/profiles";
import { useCommand } from "@movies/sdk/react";
import { Lock, Plus } from "lucide-react-native";
import { useState } from "react";
import { Alert, Pressable, View } from "react-native";

import { ProfileAvatar } from "@/components/profile-avatar";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Screen } from "@/components/ui/screen";
import { Text } from "@/components/ui/text";
import { describeFailure } from "@/lib/failure";
import { useProfileChoice } from "@/session/profile-choice";
import { useSessionPhase } from "@/session/session-phase";
import { useSignOut } from "@/session/viewer";

export default function Profiles() {
  const phase = useSessionPhase();
  const { choose } = useProfileChoice();
  const unlock = useCommand("profiles.unlock");
  const signOut = useSignOut();
  const [busy, setBusy] = useState(false);
  const profiles = phase.kind === "chooseProfile" ? phase.profiles : [];

  const askForPin = (profile: Profile) => {
    Alert.prompt(
      `Enter ${profile.name}'s PIN`,
      undefined,
      (pin) => {
        void (async () => {
          try {
            const result = await unlock({ profileId: profile.id, pin });

            if (result.status === "unlocked") await choose(profile.id);
            else if (result.status === "wrong_pin")
              Alert.alert("Wrong PIN", `${result.attemptsLeft} tries left.`);
            else Alert.alert("Profile Locked", "Too many tries. Try again later.");
          } catch (cause) {
            Alert.alert("Couldn't Unlock", describeFailure(cause));
          }
        })();
      },
      "secure-text",
      "",
      "number-pad",
    );
  };

  const pick = (profile: Profile) => {
    if (profile.locked) {
      askForPin(profile);

      return;
    }

    void choose(profile.id).catch((cause: unknown) => {
      Alert.alert("Couldn't Switch Profile", describeFailure(cause));
    });
  };

  return (
    <Screen>
      <View className="h-16 flex-row items-center px-5">
        <Text variant="largeTitle" accessibilityRole="header">
          Who’s Watching?
        </Text>
      </View>
      <View className="flex-1 justify-center gap-12 px-5">
        <View className="flex-row flex-wrap justify-center gap-8">
          {profiles.map((profile) => (
            <Pressable
              key={profile.id}
              accessibilityRole="button"
              accessibilityLabel={profile.locked ? `${profile.name}, locked` : profile.name}
              onPress={() => pick(profile)}
              className="items-center gap-3 active:opacity-70"
            >
              <ProfileAvatar profile={profile} />
              <Text variant="navTitle">{profile.name}</Text>
              {profile.hasPin ? (
                <Icon icon={Lock} tone="muted" size={14} />
              ) : profile.kids ? (
                <Text variant="meta" tone="muted">
                  Kids
                </Text>
              ) : null}
            </Pressable>
          ))}
        </View>
        <View className="gap-4">
          <Button label="Add Profile" variant="secondary" icon={Plus} disabled />
          <Button
            label="Sign Out"
            variant="secondary"
            busy={busy}
            onPress={() => {
              setBusy(true);
              void signOut().catch(() => setBusy(false));
            }}
          />
        </View>
      </View>
    </Screen>
  );
}
