import { createFileRoute } from "@tanstack/react-router";

import { ApiKeysScreen } from "@/components/keys/api-keys";

export const Route = createFileRoute("/_app/settings/api-keys")({
  head: () => ({ meta: [{ title: "API keys · [movies]" }] }),
  component: ApiKeysScreen,
});
