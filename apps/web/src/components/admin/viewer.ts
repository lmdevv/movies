import type { Viewer } from "@movies/contracts/models/account";
import type { Scope } from "@movies/contracts/scopes";
import { useCommandQuery } from "@movies/sdk/react";
import type { QueryState } from "@movies/sdk/react";

/** The signed-in account and the scopes this session holds, live. */
export const useViewer = (): QueryState<Viewer> => useCommandQuery("account.viewer", {});

/** Whether the session holds `scope`. */
export const hasScope = (viewer: Viewer, scope: Scope): boolean => viewer.scopes.includes(scope);

/** Whether the session may open any admin screen: libraries need `manage`, the rest `admin`. */
export const isAdministrator = (viewer: Viewer): boolean =>
  hasScope(viewer, "manage") || hasScope(viewer, "admin");
