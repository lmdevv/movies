/** Signing out of the account. */
import { useAuth } from "@movies/sdk/react";
import { useCallback } from "react";

import { useProfileChoice } from "./profile-choice";

/** Signs out on the server and here and forgets this device's profile choice. */
export const useSignOut = (): (() => Promise<void>) => {
  const { signOut } = useAuth();
  const { choose } = useProfileChoice();

  return useCallback(async () => {
    await signOut();
    await choose(null);
  }, [signOut, choose]);
};
