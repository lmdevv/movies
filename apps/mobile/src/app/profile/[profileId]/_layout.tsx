/**
 * The profile editor: Create Profile (`/profile/new`) or Edit Profile, with its avatar, rating,
 * and PIN screens in one stack sharing the draft. A PIN profile asks for its PIN first; one
 * unlocked only to edit it is locked again on leaving unless it is the profile in use.
 */
import type { Profile } from "@movies/contracts/models/profiles";
import { useCommand } from "@movies/sdk/react";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef } from "react";

import { ProfileEditorProvider } from "@/components/profile-editor";
import { UnlockProfile } from "@/components/unlock-profile";
import { useAccountProfiles } from "@/session/account-profiles";
import { useProfileChoice } from "@/session/profile-choice";

/** Locks `profileId` when the editor closes, if the editor unlocked it and it is not in use. */
const useRelockOnLeave = (profile: Profile | null): (() => void) => {
  const lock = useCommand("profiles.lock");
  const { profileId: chosen } = useProfileChoice();
  const unlockedHere = useRef(false);
  const profileId = profile?.id ?? null;
  const latest = useRef({ profileId, chosen });

  useEffect(() => {
    latest.current = { profileId, chosen };
  }, [profileId, chosen]);

  useEffect(
    () => () => {
      const { profileId: edited, chosen: inUse } = latest.current;

      if (unlockedHere.current && edited !== null && edited !== inUse) {
        void lock({ profileId: edited }).catch(() => undefined);
      }
    },
    [lock],
  );

  return () => {
    unlockedHere.current = true;
  };
};

function EditorStack({
  profile,
  takenAvatars,
}: {
  readonly profile: Profile | null;
  readonly takenAvatars: ReadonlyArray<string>;
}) {
  return (
    <ProfileEditorProvider profile={profile} takenAvatars={takenAvatars}>
      <Stack screenOptions={{ headerShown: false }} />
    </ProfileEditorProvider>
  );
}

export default function ProfileEditorLayout() {
  const { profileId } = useLocalSearchParams<{ profileId: string }>();
  const profiles = useAccountProfiles();
  const creating = profileId === "new";

  const profile = creating
    ? null
    : (profiles.find((candidate) => candidate.id === profileId) ?? null);

  const markUnlocked = useRelockOnLeave(profile);

  // A deleted or unknown profile has nothing to edit.
  if (!creating && profile === null) return null;

  if (profile?.locked === true) {
    return (
      <UnlockProfile
        profile={profile}
        onUnlocked={markUnlocked}
        onSwitchProfile={() => router.back()}
      />
    );
  }

  return (
    <EditorStack
      key={profile?.id ?? "new"}
      profile={profile}
      takenAvatars={profiles
        .filter((other) => other.id !== profile?.id)
        .map((other) => other.avatar)}
    />
  );
}
