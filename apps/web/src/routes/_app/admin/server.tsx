import { createFileRoute } from "@tanstack/react-router";

import { ServerScreen } from "@/components/admin/server";
import { ScopeGate } from "@/components/admin/scope-gate";

export const Route = createFileRoute("/_app/admin/server")({
  head: () => ({ meta: [{ title: "Server · [movies]" }] }),
  component: () => (
    <ScopeGate scopes={["manage", "admin"]}>
      <ServerScreen />
    </ScopeGate>
  ),
});
