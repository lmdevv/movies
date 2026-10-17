/** The signed-in account's profiles, for screens shown both before and after choosing one. */
import type { Profile } from "@movies/contracts/models/profiles";

import { useSessionPhase } from "./session-phase";

/** The account's profiles while choosing one or once one is chosen; empty otherwise. */
export const useAccountProfiles = (): ReadonlyArray<Profile> => {
  const phase = useSessionPhase();

  if (phase.kind === "chooseProfile") return phase.profiles;

  return phase.kind === "ready" ? phase.active.profiles : [];
};
