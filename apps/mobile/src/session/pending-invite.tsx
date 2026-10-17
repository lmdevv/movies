/**
 * The invite being redeemed (A06 Join Household). Opening an invite connects to its server and
 * keeps the code here, outside the connected part of the app, so the signed-out stack opens on
 * Join Household instead of Sign In.
 */
import { createContext, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";

/** The pending invite code and the way to change it. */
export interface PendingInvite {
  readonly code: string | null;
  readonly setCode: (code: string | null) => void;
}

const PendingInviteContext = createContext<PendingInvite | null>(null);

/** Holds the invite being redeemed for this launch. */
export function PendingInviteProvider({ children }: { readonly children: ReactNode }) {
  const [code, setCode] = useState<string | null>(null);
  const value = useMemo(() => ({ code, setCode }), [code]);

  return <PendingInviteContext.Provider value={value}>{children}</PendingInviteContext.Provider>;
}

/**
 * The invite being redeemed.
 *
 * @throws When used outside `PendingInviteProvider`, a programming error.
 */
export const usePendingInvite = (): PendingInvite => {
  const invite = useContext(PendingInviteContext);

  if (invite === null)
    throw new Error("usePendingInvite must be used inside PendingInviteProvider");

  return invite;
};
