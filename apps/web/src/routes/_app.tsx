import { Outlet, createFileRoute } from "@tanstack/react-router";

import { AppShell } from "@/components/shell/app-shell";
import { CurrentRoomProvider } from "@/lib/current-room";
import { RequireProfile, RequireSignedIn } from "@/session/guards";

export const Route = createFileRoute("/_app")({
  component: AppLayout,
});

/**
 * Signed-in screens: a session and an unlocked profile first, then this device's watch room, then
 * the shell around the page.
 */
function AppLayout() {
  return (
    <RequireSignedIn>
      <RequireProfile>
        <CurrentRoomProvider>
          <AppShell>
            <Outlet />
          </AppShell>
        </CurrentRoomProvider>
      </RequireProfile>
    </RequireSignedIn>
  );
}
