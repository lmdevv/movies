/** Signing out of the account. */
import { useAuth } from "@movies/sdk/react";
import { useCallback } from "react";

import { useProfileChoice } from "./profile-choice";

/** Signs out on the server and here and forgets this device's profile choice. */
export const useSignOut = (): (() => Promise<void>) => {
  const { signOut } = useAuth();
  const { choose } = useProfileChoice();

  // The local session ends even when the server cannot be told, so the profile choice is
  // forgotten either way.
  return useCallback(async () => {
    try {
      await signOut();
    } finally {
      await choose(null);
    }
  }, [signOut, choose]);
};
