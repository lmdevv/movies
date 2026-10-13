/**
 * The screens every route falls back to: an unknown address and a screen that crashed while
 * rendering. Inside the app shell they sit in the page like any other state; elsewhere (sign-in,
 * the player, a crashed shell) they take the sign-in frame with the wordmark.
 */
import { useAuth, useCommandQuery } from "@movies/sdk/react";
import { Button, buttonVariants } from "@movies/ui/components/button";
import { CalmState } from "@movies/ui/components/calm-state";
import { cn } from "@movies/ui/lib/utils";
import { Link, useMatches, useRouter } from "@tanstack/react-router";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { createContext, useContext } from "react";
import type { ReactNode } from "react";

import { AuthPage } from "@/components/auth/auth-page";

const InShellContext = createContext(false);

/** Marks `children` as rendered inside the app shell, which already draws the top bar. */
export function InShell({ children }: { readonly children: ReactNode }) {
  return <InShellContext.Provider value>{children}</InShellContext.Provider>;
}

function StateFrame({ children }: { readonly children: ReactNode }) {
  const inShell = useContext(InShellContext);

  // Billboard routes leave the top bar's height to the page.
  const hero = useMatches({
    select: (matches) => matches.some((match) => match.staticData.hero === true),
  });

  if (!inShell) {
    return (
      <AuthPage width="dialog" offset="lead">
        {children}
      </AuthPage>
    );
  }

  return (
    <div
      className={cn(
        "flex min-h-[60svh] flex-col items-center justify-center gap-8 px-6",
        hero && "md:pt-17",
      )}
    >
      {children}
    </div>
  );
}

const goHome = (variant: "primary" | "subtle") => (
  <Link to="/" className={buttonVariants({ variant })}>
    Go home
  </Link>
);

/** What threw, with its stack when it has one. Anything thrown may reach a route's boundary. */
const errorText = (cause: unknown): string => {
  if (!(cause instanceof Error)) return String(cause);

  return cause.stack ?? `${cause.name}: ${cause.message}`;
};

/** An address no route serves, such as a mistyped or outdated link. */
export function NotFoundPage() {
  return (
    <StateFrame>
      <title>Not found · [movies]</title>
      <CalmState title="This page isn't here" actions={goHome("primary")} />
    </StateFrame>
  );
}

/**
 * A route that threw while rendering. Try again renders it afresh; people who manage the server
 * can open the error itself.
 */
export function RouteErrorPage({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  const { status } = useAuth();
  // Only a session can manage the server; signed out, the screen asks the server nothing.
  const viewer = useCommandQuery("account.viewer", status === "signedIn" ? {} : "skip");
  const canManage = viewer.status === "success" && viewer.data.scopes.includes("manage");

  return (
    <StateFrame>
      <CalmState
        title="Something went wrong"
        actions={
          <>
            <Button
              onClick={() => {
                reset();
                void router.invalidate();
              }}
            >
              Try again
            </Button>
            {goHome("subtle")}
          </>
        }
      />
      {canManage ? (
        <details className="mx-auto w-full max-w-130 font-sans">
          <summary className="cursor-pointer text-center text-label/label text-text-muted">
            Error details
          </summary>
          <pre className="mt-3 max-h-60 overflow-auto rounded-control bg-surface p-4 font-mono text-caption/caption whitespace-pre-wrap text-text-muted">
            {errorText(error)}
          </pre>
        </details>
      ) : null}
    </StateFrame>
  );
}
