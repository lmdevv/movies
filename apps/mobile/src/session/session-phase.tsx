/**
 * Where the app stands: not connected, signed out, choosing a profile, or ready, and on a server
 * without an owner, creating the owner account and setting up its first library. The root stack
 * shows only the screens of the current phase, so changing phase (signing in, choosing a
 * profile, signing out) moves to the right place by itself.
 */
import { useAuth, useCommandQuery } from "@movies/sdk/react";
import type { QueryState } from "@movies/sdk/react";
import type { SetupStatus } from "@movies/contracts/models/account";
import type { Profile } from "@movies/contracts/models/profiles";
import { createContext, useContext, useMemo, useState } from "react";

import { isFailure } from "@/lib/failure";

import type { ActiveProfile } from "./active-profile";
import { useFirstRun } from "./first-run";
import { useProfileChoice } from "./profile-choice";

/** The phases the root stack switches between. */
export type SessionPhase =
  | { readonly kind: "loading" }
  | { readonly kind: "disconnected" }
  | { readonly kind: "signedOut" }
  /** Signed out on a server without an owner yet, or while the owner account is created (I14). */
  | { readonly kind: "createOwner" }
  /** The owner just created here sets up a first library (I15) before choosing a profile. */
  | { readonly kind: "setup"; readonly profiles: ReadonlyArray<Profile> }
  | { readonly kind: "chooseProfile"; readonly profiles: ReadonlyArray<Profile> }
  | { readonly kind: "ready"; readonly active: ActiveProfile }
  /** Signed in, but the profiles could not be read; `retry` asks again. */
  | { readonly kind: "unavailable"; readonly cause: unknown; readonly retry: () => void };

/** Signed out: create the owner account on a server without one, otherwise sign in. */
const signedOutPhase = (setup: QueryState<SetupStatus>, settingUp: boolean): SessionPhase => {
  // Convex reports the new owner before the sign-up resolves, so setup holds the form meanwhile.
  if (settingUp) return { kind: "createOwner" };

  // Until the server says it has no owner, sign-in shows: signing out never waits on the
  // question, and a server that cannot say still has sign-in, which reports its own trouble.
  return setup.status === "success" && !setup.data.hasOwner
    ? { kind: "createOwner" }
    : { kind: "signedOut" };
};

const phaseFor = (
  status: "loading" | "signedIn" | "signedOut",
  profiles: QueryState<ReadonlyArray<Profile>>,
  profileId: string | null,
  setup: QueryState<SetupStatus>,
  settingUp: boolean,
): SessionPhase => {
  if (status === "loading") return { kind: "loading" };

  if (status === "signedOut") return signedOutPhase(setup, settingUp);

  if (profiles.status === "loading") return { kind: "loading" };

  if (profiles.status === "error") {
    // A revoked session flips the auth status next, which moves to sign-in.
    return isFailure(profiles.error, "Unauthenticated")
      ? { kind: "loading" }
      : { kind: "unavailable", cause: profiles.error, retry: profiles.retry };
  }

  if (settingUp) return { kind: "setup", profiles: profiles.data };

  const profile = profiles.data.find((candidate) => candidate.id === profileId);

  if (profile === undefined || profile.locked) {
    return { kind: "chooseProfile", profiles: profiles.data };
  }

  return { kind: "ready", active: { profile, profiles: profiles.data } };
};

/** The phase of the connected app, computed from the session and the profile list. */
export const useLiveSessionPhase = (): SessionPhase => {
  const { status } = useAuth();
  const { profileId } = useProfileChoice();
  const profiles = useCommandQuery("profiles.list", status === "signedIn" ? {} : "skip");
  const setup = useCommandQuery("setup.status", status === "signedOut" ? {} : "skip");
  const settingUp = useFirstRun().active;

  return useMemo(
    () => phaseFor(status, profiles, profileId, setup, settingUp),
    [status, profiles, profileId, setup, settingUp],
  );
};

/** A phase the root stack has screens for. */
export type SettledPhase = Extract<
  SessionPhase,
  { readonly kind: "signedOut" | "createOwner" | "setup" | "chooseProfile" | "ready" }
>;

const isSettled = (phase: SessionPhase): phase is SettledPhase =>
  phase.kind === "signedOut" ||
  phase.kind === "createOwner" ||
  phase.kind === "setup" ||
  phase.kind === "chooseProfile" ||
  phase.kind === "ready";

/** Whether `next` shows the same screens as `last`: the same phase and, once ready, profile. */
const sameScreens = (next: SettledPhase, last: SettledPhase | null): boolean => {
  if (last === null || next.kind !== last.kind) return false;

  return (
    next.kind !== "ready" ||
    (last.kind === "ready" && next.active.profile.id === last.active.profile.id)
  );
};

/**
 * `phase` when it is settled, else the last settled phase, or null before the first. A reload or
 * a failed refresh then keeps the screens, and their navigation, in place instead of unmounting
 * them.
 */
export const useSettledPhase = (phase: SessionPhase): SettledPhase | null => {
  const [last, setLast] = useState<SettledPhase | null>(null);

  if (isSettled(phase) && !sameScreens(phase, last)) setLast(phase);

  return isSettled(phase) ? phase : last;
};

/** The settled phase, shared so screens read it without subscribing to the profiles again. */
export const SessionPhaseContext = createContext<SettledPhase | null>(null);

/**
 * The phase the screens on show belong to.
 *
 * @throws When used outside the connected app, a programming error.
 */
export const useSessionPhase = (): SettledPhase => {
  const phase = useContext(SessionPhaseContext);

  if (phase === null) throw new Error("useSessionPhase must be used inside the connected app");

  return phase;
};
