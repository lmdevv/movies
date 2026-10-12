import type { ProfileId } from "@movies/contracts/ids";
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { loadProfileChoice, saveProfileChoice } from "@/lib/device-storage";

/** The profile chosen on this browser and the way to change it. */
export interface ProfileChoice {
  /** The chosen profile, or null before anyone picked one on this browser. */
  readonly profileId: ProfileId | null;
  /** Chooses a profile (persisted per browser), or forgets the choice with null. */
  readonly choose: (profileId: ProfileId | null) => void;
}

const ProfileChoiceContext = createContext<ProfileChoice | null>(null);

/** Holds the per-browser profile choice, starting from what `localStorage` remembers. */
export function ProfileChoiceProvider({ children }: { readonly children: ReactNode }) {
  const [profileId, setProfileId] = useState<ProfileId | null>(loadProfileChoice);

  const choose = useCallback((next: ProfileId | null) => {
    saveProfileChoice(next);
    setProfileId(next);
  }, []);

  const value = useMemo(() => ({ profileId, choose }), [profileId, choose]);

  return <ProfileChoiceContext.Provider value={value}>{children}</ProfileChoiceContext.Provider>;
}

/**
 * The profile chosen on this browser. Prefer `useActiveProfile` inside signed-in screens: it also
 * guarantees the profile exists and is unlocked.
 *
 * @throws When used outside `ProfileChoiceProvider`, a programming error.
 */
export const useProfileChoice = (): ProfileChoice => {
  const choice = useContext(ProfileChoiceContext);

  if (choice === null)
    throw new Error("useProfileChoice must be used inside ProfileChoiceProvider");

  return choice;
};
