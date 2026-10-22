import { createFileRoute } from "@tanstack/react-router";
import { Schema } from "effect";

import { ApiKeysScreen } from "@/components/keys/api-keys";

const ApiKeysSearch = Schema.Struct({ dialog: Schema.optionalKey(Schema.String) });

export const Route = createFileRoute("/_app/settings/api-keys")({
  validateSearch: Schema.toStandardSchemaV1(ApiKeysSearch),
  head: () => ({ meta: [{ title: "API keys · [movies]" }] }),
  component: ApiKeysPage,
});

function ApiKeysPage() {
  const { dialog } = Route.useSearch();
  const navigate = Route.useNavigate();

  return (
    <ApiKeysScreen
      creating={dialog === "create"}
      onCreatingChange={(open) =>
        void navigate({ search: open ? { dialog: "create" } : {}, replace: true })
      }
    />
  );
}
