import { Outlet, createFileRoute } from "@tanstack/react-router";

import { AppShell } from "@/components/shell/app-shell";
import { CurrentRoomProvider } from "@/lib/current-room";
import { RequireProfile, RequireSignedIn } from "@/session/guards";

export const Route = createFileRoute("/_app")({
  component: AppLayout,
});

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
