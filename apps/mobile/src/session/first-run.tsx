/**
 * First run on a server without an owner: I14 Create Owner Account, then I15 Add Your First
 * Library and its first scan, then Home. Setup starts when the owner account is submitted here and
 * lasts until the owner adds a library and moves on, or sets it up later; the session phase shows
 * its screens meanwhile. It lives in memory only: an app reopened mid-setup goes to Home, whose
 * empty library offers Add a Library.
 */
import { router } from "expo-router";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import type { SessionPhase } from "./session-phase";

/** Where setup goes once the owner account exists: Add Your First Library, or an import. */
export type SetupStart = "library" | "import";

/** Whether owner setup is under way on this device, and the ways to move it along. */
interface FirstRun {
  /** True from submitting the owner account until setup ends or the account is refused. */
  readonly active: boolean;
  /** Where setup opens; the import is opened once, over Add Your First Library. */
  readonly start: SetupStart;
  /** Starts setup as the owner account is submitted. */
  readonly begin: (start: SetupStart) => void;
  /** Marks the import as opened, so going back from it stays on Add Your First Library. */
  readonly startedImport: () => void;
  /** Ends setup, after it finished or when the owner account was refused. */
  readonly end: () => void;
}

const FirstRunContext = createContext<FirstRun | null>(null);

/** Holds whether owner setup is under way. */
export function FirstRunProvider({ children }: { readonly children: ReactNode }) {
  const [active, setActive] = useState(false);
  const [start, setStart] = useState<SetupStart>("library");

  const value = useMemo(
    (): FirstRun => ({
      active,
      start,
      begin: (next) => {
        setStart(next);
        setActive(true);
      },
      startedImport: () => setStart("library"),
      end: () => setActive(false),
    }),
    [active, start],
  );

  return <FirstRunContext.Provider value={value}>{children}</FirstRunContext.Provider>;
}

/**
 * Owner setup on this device.
 *
 * @throws When used outside `FirstRunProvider`, a programming error.
 */
export const useFirstRun = (): FirstRun => {
  const firstRun = useContext(FirstRunContext);

  if (firstRun === null) throw new Error("useFirstRun must be used inside FirstRunProvider");

  return firstRun;
};

/**
 * Goes Home when owner setup ends. The owner screens stay allowed once the app is ready, so the
 * stack would otherwise keep showing them instead of moving to Home by itself.
 */
export const useHomeAfterSetup = (phase: SessionPhase["kind"]): void => {
  const previous = useRef(phase);

  useEffect(() => {
    if (previous.current === "setup" && phase === "ready") router.replace("/");

    previous.current = phase;
  }, [phase]);
};
