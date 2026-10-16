/**
 * The profile chosen on this phone. Switching to another profile locks the one left behind on the
 * session first, so its PIN keeps guarding it: unlocks live on the server session, which every
 * profile on this phone shares.
 */
import type { ProfileId } from "@movies/contracts/ids";
import { useCommand } from "@movies/sdk/react";
import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import { useDevice } from "@/device/device-state";

/** The chosen profile and the way to change it. */
export interface ProfileChoice {
  /** The chosen profile, or null before anyone picked one on this phone. */
  readonly profileId: ProfileId | null;
  /**
   * Chooses a profile (remembered on this phone), or forgets the choice with null. Rejects when
   * the profile left behind could not be locked; the choice then stays.
   */
  readonly choose: (profileId: ProfileId | null) => Promise<void>;
}

const ProfileChoiceContext = createContext<ProfileChoice | null>(null);

/** Holds the profile choice, starting from the one remembered at launch. */
export function ProfileChoiceProvider({ children }: { readonly children: ReactNode }) {
  const { launchProfileId, saveProfile } = useDevice();
  const [profileId, setProfileId] = useState(launchProfileId);
  const current = useRef(launchProfileId);
  const lock = useCommand("profiles.lock");

  const choose = useCallback(
    async (next: ProfileId | null) => {
      const previous = current.current;

      // Signing out (null) ends the session and every unlock with it.
      if (previous !== null && next !== null && previous !== next) {
        await lock({ profileId: previous });
      }

      current.current = next;
      setProfileId(next);
      await saveProfile(next);
    },
    [lock, saveProfile],
  );

  const value = useMemo(() => ({ profileId, choose }), [profileId, choose]);

  return <ProfileChoiceContext.Provider value={value}>{children}</ProfileChoiceContext.Provider>;
}

/**
 * The profile chosen on this phone. Inside signed-in screens prefer `useActiveProfile`, which also
 * guarantees the profile exists and is unlocked.
 *
 * @throws When used outside `ProfileChoiceProvider`, a programming error.
 */
export const useProfileChoice = (): ProfileChoice => {
  const choice = useContext(ProfileChoiceContext);

  if (choice === null) {
    throw new Error("useProfileChoice must be used inside ProfileChoiceProvider");
  }

  return choice;
};
