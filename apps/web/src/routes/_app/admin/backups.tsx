import { createFileRoute } from "@tanstack/react-router";

import { BackupsScreen } from "@/components/admin/backups";
import { ScopeGate } from "@/components/admin/scope-gate";

export const Route = createFileRoute("/_app/admin/backups")({
  head: () => ({ meta: [{ title: "Backups · [movies]" }] }),
  component: () => (
    <ScopeGate scopes={["admin"]}>
      <BackupsScreen />
    </ScopeGate>
  ),
});
