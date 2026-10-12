import { createFileRoute } from "@tanstack/react-router";
import { Schema } from "effect";

import { DeviceApproval } from "@/components/device/device-approval";

const DeviceSearch = Schema.Struct({ code: Schema.optionalKey(Schema.String) });

export const Route = createFileRoute("/device")({
  validateSearch: Schema.toStandardSchemaV1(DeviceSearch),
  head: () => ({ meta: [{ title: "Sign in a device · [movies]" }] }),
  component: DevicePage,
});

function DevicePage() {
  const { code } = Route.useSearch();

  return <DeviceApproval code={code} />;
}
