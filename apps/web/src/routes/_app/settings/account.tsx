import { createFileRoute } from "@tanstack/react-router";

import { AccountScreen } from "@/components/keys/account";

export const Route = createFileRoute("/_app/settings/account")({
  head: () => ({ meta: [{ title: "Account · [movies]" }] }),
  component: AccountScreen,
});
