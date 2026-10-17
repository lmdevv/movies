/** B01 · Who's Watching?: choose a profile; PIN profiles ask for it first; the pencil manages them. */
import type { Profile } from "@movies/contracts/models/profiles";
import { router } from "expo-router";
import { Lock, Pencil, Plus } from "lucide-react-native";
import { useState } from "react";
import { Alert, Pressable, ScrollView, View } from "react-native";

import { ProfileAvatar } from "@/components/profile-avatar";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { Screen } from "@/components/ui/screen";
import { Text } from "@/components/ui/text";
import { describeFailure } from "@/lib/failure";
import { canAddProfile } from "@/lib/profile-draft";
import { useProfileChoice } from "@/session/profile-choice";
import { useSessionPhase } from "@/session/session-phase";
import { useSignOut } from "@/session/viewer";

function ProfileTile({
  profile,
  onPress,
}: {
  readonly profile: Profile;
  readonly onPress: () => void;
}) {
  const detail = profile.hasPin ? "PIN" : profile.kids ? "Kids" : null;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={detail === null ? profile.name : `${profile.name}, ${detail}`}
      onPress={onPress}
      className="items-center gap-3 active:opacity-70"
    >
      <ProfileAvatar profile={profile} />
      <Text variant="navTitle" numberOfLines={1} className="max-w-28">
        {profile.name}
      </Text>
      {profile.hasPin ? (
        <Icon icon={Lock} tone="muted" size="chevron" />
      ) : profile.kids ? (
        <Text variant="metaStrong" tone="muted">
          Kids
        </Text>
      ) : null}
    </Pressable>
  );
}

export default function Profiles() {
  const phase = useSessionPhase();
  const { choose } = useProfileChoice();
  const signOut = useSignOut();
  const [busy, setBusy] = useState(false);
  const profiles = phase.kind === "chooseProfile" ? phase.profiles : [];

  const pick = (profile: Profile) => {
    if (profile.locked) {
      router.push({ pathname: "/profile-pin/[profileId]", params: { profileId: profile.id } });

      return;
    }

    void choose(profile.id).catch((cause: unknown) => {
      Alert.alert("Couldn’t Switch Profile", describeFailure(cause));
    });
  };

  return (
    <Screen>
      <View className="h-16 flex-row items-center gap-3 px-5">
        <Text variant="largeTitle" accessibilityRole="header" className="flex-1">
          Who’s Watching?
        </Text>
        <IconButton
          icon={Pencil}
          label="Manage Profiles"
          onPress={() => router.push("/manage-profiles")}
        />
      </View>
      <ScrollView contentContainerClassName="gap-4 px-5 py-4">
        <View className="h-24" />
        <View className="flex-row flex-wrap justify-center gap-8">
          {profiles.map((profile) => (
            <ProfileTile key={profile.id} profile={profile} onPress={() => pick(profile)} />
          ))}
        </View>
        <View className="h-8" />
        {canAddProfile(profiles.length) ? (
          <Button
            label="Add Profile"
            variant="secondary"
            icon={Plus}
            onPress={() =>
              router.push({ pathname: "/profile/[profileId]", params: { profileId: "new" } })
            }
          />
        ) : null}
        <Button
          label="Sign Out"
          variant="secondary"
          busy={busy}
          onPress={() => {
            setBusy(true);
            void signOut().catch(() => setBusy(false));
          }}
        />
      </ScrollView>
    </Screen>
  );
}
