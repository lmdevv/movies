/**
 * The profile chosen on this device. Switching to another profile locks the one left behind on
 * this session first, so a PIN keeps guarding it: unlocks live on the server session, which every
 * profile on this device shares.
 */
import { ProfileId } from "@movies/contracts/ids";
import { useCommand } from "@movies/sdk/react";
import { Option, Schema } from "effect";
import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import { readValue, writeValue } from "@/lib/secure-storage";

const KEY = "movies.profile";

const decodeProfileId = Schema.decodeUnknownOption(ProfileId);

const loadProfileChoice = (): ProfileId | null => Option.getOrNull(decodeProfileId(readValue(KEY)));

/** The profile chosen on this device and the way to change it. */
export interface ProfileChoice {
  readonly profileId: ProfileId | null;
  /**
   * Chooses a profile, or forgets the choice with null. Leaving one profile for another resolves
   * once the one left behind is locked, and rejects when locking fails.
   */
  readonly choose: (profileId: ProfileId | null) => Promise<void>;
}

const ProfileChoiceContext = createContext<ProfileChoice | null>(null);

/** Holds the profile choice, starting from the one this device remembers. */
export function ProfileChoiceProvider({ children }: { readonly children: ReactNode }) {
  const [profileId, setProfileId] = useState<ProfileId | null>(loadProfileChoice);
  const current = useRef(profileId);
  const lock = useCommand("profiles.lock");

  const commit = useCallback((next: ProfileId | null) => {
    current.current = next;
    writeValue(KEY, next);
    setProfileId(next);
  }, []);

  const choose = useCallback(
    async (next: ProfileId | null) => {
      const previous = current.current;

      // Signing out (null) ends the session and every unlock with it.
      if (previous !== null && next !== null && previous !== next) {
        await lock({ profileId: previous });
      }

      commit(next);
    },
    [commit, lock],
  );

  const value = useMemo(() => ({ profileId, choose }), [profileId, choose]);

  return <ProfileChoiceContext.Provider value={value}>{children}</ProfileChoiceContext.Provider>;
}

/**
 * The profile chosen on this device.
 *
 * @throws When used outside `ProfileChoiceProvider`, a programming error.
 */
export const useProfileChoice = (): ProfileChoice => {
  const choice = useContext(ProfileChoiceContext);

  if (choice === null)
    throw new Error("useProfileChoice must be used inside ProfileChoiceProvider");

  return choice;
};
