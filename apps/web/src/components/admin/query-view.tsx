import type { QueryState } from "@movies/sdk/react";
import { Match } from "effect";
import type { ReactNode } from "react";

import { describeFailure } from "./action";

/**
 * Renders a live query: `loading` until the first result, its failure as one muted line, then
 * `children` with the data on every update.
 */
export function QueryView<A>({
  query,
  loading,
  children,
}: {
  readonly query: QueryState<A>;
  readonly loading: ReactNode;
  readonly children: (data: A) => ReactNode;
}): ReactNode {
  return Match.value(query).pipe(
    Match.discriminatorsExhaustive("status")({
      loading: () => loading,
      error: ({ error }) => (
        <p className="font-sans text-body/body text-text-muted">{describeFailure(error)}</p>
      ),
      success: ({ data }) => children(data),
    }),
  );
}
