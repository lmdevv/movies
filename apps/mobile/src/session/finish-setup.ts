import { useCallback } from "react";

import { useFirstRun } from "./first-run";
import { useProfileChoice } from "./profile-choice";
import { useSessionPhase } from "./session-phase";

/**
 * Ends owner setup. The new owner has one profile, made with the account, so it is chosen and
 * setup goes straight to Home (I06 → C13); with any other count, or when the choice cannot be
 * saved, Who's Watching? asks instead. It never fails. Outside setup it does nothing.
 */
export const useFinishSetup = (): (() => Promise<void>) => {
  const phase = useSessionPhase();
  const { choose } = useProfileChoice();
  const { end } = useFirstRun();

  return useCallback(async () => {
    if (phase.kind !== "setup") return;

    const [only, ...others] = phase.profiles;

    if (only !== undefined && others.length === 0 && !only.locked) {
      await choose(null)
        .then(() => choose(only.id))
        .catch(() => undefined);
    }

    end();
  }, [phase, choose, end]);
};
