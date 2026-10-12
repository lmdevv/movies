import type { Scope } from "@movies/contracts/scopes";
import { buttonVariants } from "@movies/ui/components/button";
import { CalmState } from "@movies/ui/components/calm-state";
import { Spinner } from "@movies/ui/components/spinner";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { hasScope, useViewer } from "./viewer";

/**
 * Renders `children` only for sessions that hold one of `scopes`. Others see a calm “not for this
 * account” state; the server refuses their calls anyway, so this only spares them broken screens.
 */
export function ScopeGate({
  scopes,
  children,
}: {
  readonly scopes: ReadonlyArray<Scope>;
  readonly children: ReactNode;
}) {
  const viewer = useViewer();

  if (viewer.status === "loading") {
    return (
      <div className="flex justify-center py-24">
        <Spinner className="size-8 text-text" label="Loading" />
      </div>
    );
  }

  if (viewer.status === "success" && scopes.some((scope) => hasScope(viewer.data, scope))) {
    return children;
  }

  return (
    <CalmState
      className="py-24"
      title="Only admins can open this"
      description={viewer.status === "error" ? viewer.error.message : undefined}
      actions={
        <Link to="/" className={buttonVariants({ variant: "raised", size: "sm" })}>
          Go to Home
        </Link>
      }
    />
  );
}
