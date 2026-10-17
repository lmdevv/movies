/**
 * B05–B07 · Enter PIN before opening a PIN profile, from Who's Watching? or the switcher sheet.
 * Unlocking chooses the profile; leaving another profile locks that one behind it.
 */
import { router, useLocalSearchParams } from "expo-router";
import { Alert } from "react-native";

import { UnlockProfile } from "@/components/unlock-profile";
import { describeFailure } from "@/lib/failure";
import { useAccountProfiles } from "@/session/account-profiles";
import { useProfileChoice } from "@/session/profile-choice";

const back = () => (router.canGoBack() ? router.back() : router.replace("/"));

export default function ProfilePin() {
  const { profileId } = useLocalSearchParams<{ profileId: string }>();
  const profiles = useAccountProfiles();
  const { choose } = useProfileChoice();
  const profile = profiles?.find((candidate) => candidate.id === profileId);

  if (profile === undefined) return null;

  return (
    <UnlockProfile
      key={profile.id}
      profile={profile}
      onSwitchProfile={back}
      onUnlocked={() => {
        void choose(profile.id)
          .then(() => router.dismissTo("/"))
          .catch((cause: unknown) => {
            Alert.alert("Couldn’t Switch Profile", describeFailure(cause));
          });
      }}
    />
  );
}
