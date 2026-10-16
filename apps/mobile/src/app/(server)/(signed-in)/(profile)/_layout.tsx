/**
 * Screens that belong to a profile. Without a chosen profile people go to Who's watching; a
 * profile with a PIN this session has not unlocked goes to its PIN screen.
 */
import { describeFailure, isFailure } from "@movies/sdk/failure";
import { useCommandQuery } from "@movies/sdk/react";
import { Redirect, Stack } from "expo-router";
import { useMemo } from "react";

import { ActiveProfileContext } from "@/session/active-profile";
import type { ActiveProfile } from "@/session/active-profile";
import { useProfileChoice } from "@/session/profile-choice";
import { colors } from "@/theme/tokens";
import { PrimaryButton } from "@/ui/button";
import { CalmState } from "@/ui/calm-state";
import { BlankScreen } from "@/ui/screen";

export default function ProfileLayout() {
  const { profileId } = useProfileChoice();
  const profiles = useCommandQuery("profiles.list", {});

  const active = useMemo((): ActiveProfile | null => {
    if (profiles.status !== "success") return null;

    const profile = profiles.data.find((candidate) => candidate.id === profileId);

    return profile === undefined ? null : { profile, profiles: profiles.data };
  }, [profiles, profileId]);

  if (profiles.status === "loading") return <BlankScreen />;

  if (profiles.status === "error") {
    // A revoked session flips the auth status next; the signed-in layout then redirects.
    return isFailure(profiles.error, "Unauthenticated") ? (
      <BlankScreen />
    ) : (
      <CalmState
        title="Something went wrong"
        description={describeFailure(profiles.error)}
        actions={<PrimaryButton label="Try again" onPress={profiles.retry} />}
      />
    );
  }

  if (active === null) return <Redirect href="/profiles" />;

  if (active.profile.locked) {
    return (
      <Redirect
        href={{ pathname: "/profiles/[profileId]/pin", params: { profileId: active.profile.id } }}
      />
    );
  }

  return (
    <ActiveProfileContext.Provider value={active}>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }} />
    </ActiveProfileContext.Provider>
  );
}
