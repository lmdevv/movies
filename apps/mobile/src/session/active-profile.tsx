/** The chosen, unlocked profile that everything below `(profile)` belongs to. */
import type { Profile } from "@movies/contracts/models/profiles";
import { createContext, useContext } from "react";

/** The profile everything on screen belongs to, and its account's other profiles. */
export interface ActiveProfile {
  readonly profile: Profile;
  readonly profiles: ReadonlyArray<Profile>;
}

/** Provided by the `(profile)` layout once a profile is chosen and unlocked. */
export const ActiveProfileContext = createContext<ActiveProfile | null>(null);

/**
 * The chosen, unlocked profile. Pass its id to every profile-scoped command.
 *
 * @throws When used outside the `(profile)` layout, a programming error.
 */
export const useActiveProfile = (): ActiveProfile => {
  const active = useContext(ActiveProfileContext);

  if (active === null) throw new Error("useActiveProfile must be used inside the (profile) layout");

  return active;
};
