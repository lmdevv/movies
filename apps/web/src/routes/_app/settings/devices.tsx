import { createFileRoute } from "@tanstack/react-router";

import { DevicesScreen } from "@/components/keys/devices";

export const Route = createFileRoute("/_app/settings/devices")({
  head: () => ({ meta: [{ title: "Devices · [movies]" }] }),
  component: DevicesScreen,
});
