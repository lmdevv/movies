import { createFileRoute } from "@tanstack/react-router";

import { UsersScreen } from "@/components/admin/users";
import { ScopeGate } from "@/components/admin/scope-gate";

export const Route = createFileRoute("/_app/admin/users")({
  head: () => ({ meta: [{ title: "Users · [movies]" }] }),
  component: () => (
    <ScopeGate scopes={["admin"]}>
      <UsersScreen />
    </ScopeGate>
  ),
});
