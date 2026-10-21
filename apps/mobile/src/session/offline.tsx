/**
 * Offline: the server cannot be reached, and the downloads kept here are all there is. The root
 * stack shows only the Downloads list and what it opens; `leave` tries the server again.
 */
import { createContext, useContext } from "react";

/** The way back from offline. */
export interface Offline {
  /** Leaves the downloads and tries the server again. */
  readonly leave: () => void;
}

export const OfflineContext = createContext<Offline | null>(null);

/** The way back from offline, or null while the server answers. */
export const useOffline = (): Offline | null => useContext(OfflineContext);
