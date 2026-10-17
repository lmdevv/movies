/**
 * The profile editor: Create Profile (`/profile/new`) or Edit Profile, with its avatar, rating,
 * and PIN screens in one stack sharing the draft. A PIN profile asks for its PIN first and is
 * locked again on leaving unless it is the profile in use.
 */
import type { Profile } from "@movies/contracts/models/profiles";
import { useCommand } from "@movies/sdk/react";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef } from "react";

import { ProfileEditorProvider } from "@/components/profile-editor";
import { UnlockProfile } from "@/components/unlock-profile";
import { useAccountProfiles } from "@/session/account-profiles";
import { useProfileChoice } from "@/session/profile-choice";

/**
 * Locks the edited profile when the editor closes if it has a PIN and is not the profile in use:
 * unlocking it to edit it, or setting its PIN, leaves it unlocked on this session otherwise.
 */
const useLockOnLeave = (profile: Profile | null): void => {
  const lock = useCommand("profiles.lock");
  const { profileId: chosen } = useProfileChoice();
  const profileId = profile?.id ?? null;
  const hasPin = profile?.hasPin ?? false;
  const latest = useRef({ profileId, chosen, hasPin });

  useEffect(() => {
    latest.current = { profileId, chosen, hasPin };
  }, [profileId, chosen, hasPin]);

  useEffect(
    () => () => {
      const { profileId: edited, chosen: inUse, hasPin: guarded } = latest.current;

      if (guarded && edited !== null && edited !== inUse) {
        void lock({ profileId: edited }).catch(() => undefined);
      }
    },
    [lock],
  );
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
    : (profiles?.find((candidate) => candidate.id === profileId) ?? null);

  useLockOnLeave(profile);

  // Wait for the profiles (a new one starts on an avatar they leave free); a deleted or unknown
  // profile has nothing to edit.
  if (profiles === null || (!creating && profile === null)) return null;

  if (profile?.locked === true) {
    return <UnlockProfile profile={profile} onSwitchProfile={() => router.back()} />;
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
