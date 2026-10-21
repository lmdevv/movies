/**
 * The signed-in account on the owner screens: who it is and what this session may do. Owner
 * Settings opens for sessions holding `manage` (libraries, scans, matches) or `admin` (users,
 * invites, backups, import); each screen shows only what the session may use.
 */
import type { Viewer } from "@movies/contracts/models/account";
import { createContext, useContext } from "react";

/** The viewer of the owner screens, provided by their layout once it loads. */
export const OwnerViewerContext = createContext<Viewer | null>(null);

/**
 * The signed-in account and its scopes.
 *
 * @throws When used outside the owner screens, a programming error.
 */
export const useOwnerViewer = (): Viewer => {
  const viewer = useContext(OwnerViewerContext);

  if (viewer === null) throw new Error("useOwnerViewer must be used inside the owner screens");

  return viewer;
};

/** Whether `viewer` may open the owner screens at all. */
export const mayOpenOwnerSettings = (viewer: Viewer): boolean =>
  viewer.scopes.includes("manage") || viewer.scopes.includes("admin");
