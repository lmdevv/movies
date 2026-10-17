/**
 * Where the app stands: not connected, signed out, choosing a profile, or ready. The root stack
 * shows only the screens of the current phase, so changing phase (signing in, choosing a
 * profile, signing out) moves to the right place by itself.
 */
import { useAuth, useCommandQuery } from "@movies/sdk/react";
import type { QueryState } from "@movies/sdk/react";
import type { Profile } from "@movies/contracts/models/profiles";
import { useMemo } from "react";

import { isFailure } from "@/lib/failure";

import type { ActiveProfile } from "./active-profile";
import { useProfileChoice } from "./profile-choice";

/** The phases the root stack switches between. */
export type SessionPhase =
  | { readonly kind: "loading" }
  | { readonly kind: "disconnected" }
  | { readonly kind: "signedOut" }
  | { readonly kind: "chooseProfile"; readonly profiles: ReadonlyArray<Profile> }
  | { readonly kind: "ready"; readonly active: ActiveProfile }
  /** Signed in, but the profiles could not be read; `retry` asks again. */
  | { readonly kind: "unavailable"; readonly cause: unknown; readonly retry: () => void };

const phaseFor = (
  status: "loading" | "signedIn" | "signedOut",
  profiles: QueryState<ReadonlyArray<Profile>>,
  profileId: string | null,
): SessionPhase => {
  if (status === "loading") return { kind: "loading" };

  if (status === "signedOut") return { kind: "signedOut" };

  if (profiles.status === "loading") return { kind: "loading" };

  if (profiles.status === "error") {
    // A revoked session flips the auth status next, which moves to sign-in.
    return isFailure(profiles.error, "Unauthenticated")
      ? { kind: "loading" }
      : { kind: "unavailable", cause: profiles.error, retry: profiles.retry };
  }

  const profile = profiles.data.find((candidate) => candidate.id === profileId);

  if (profile === undefined || profile.locked) {
    return { kind: "chooseProfile", profiles: profiles.data };
  }

  return { kind: "ready", active: { profile, profiles: profiles.data } };
};

/** The phase of the connected app. */
export const useSessionPhase = (): SessionPhase => {
  const { status } = useAuth();
  const { profileId } = useProfileChoice();
  const profiles = useCommandQuery("profiles.list", status === "signedIn" ? {} : "skip");

  return useMemo(() => phaseFor(status, profiles, profileId), [status, profiles, profileId]);
};
