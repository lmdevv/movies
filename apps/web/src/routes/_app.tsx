import { Outlet, createFileRoute } from "@tanstack/react-router";

import { AppShell } from "@/components/shell/app-shell";
import { RequireProfile, RequireSignedIn } from "@/session/guards";

export const Route = createFileRoute("/_app")({
  component: AppLayout,
});

/** Signed-in screens: a session and an unlocked profile first, then the shell around the page. */
function AppLayout() {
  return (
    <RequireSignedIn>
      <RequireProfile>
        <AppShell>
          <Outlet />
        </AppShell>
      </RequireProfile>
    </RequireSignedIn>
  );
}
