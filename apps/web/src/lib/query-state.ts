/** Reading query states for display. */
import type { QueryState } from "@movies/sdk/react";

/** A list query's rows, null while it loads; one that failed lists nothing rather than loading forever. */
export const listOrLoading = <A>(state: QueryState<ReadonlyArray<A>>): ReadonlyArray<A> | null => {
  if (state.status === "success") return state.data;

  return state.status === "error" ? [] : null;
};
