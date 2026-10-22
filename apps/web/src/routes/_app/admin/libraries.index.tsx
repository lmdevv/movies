import { createFileRoute } from "@tanstack/react-router";
import { Schema } from "effect";

import { LibrariesScreen } from "@/components/admin/libraries";
import { ScopeGate } from "@/components/admin/scope-gate";

const LibrariesSearch = Schema.Struct({ dialog: Schema.optionalKey(Schema.String) });

export const Route = createFileRoute("/_app/admin/libraries/")({
  validateSearch: Schema.toStandardSchemaV1(LibrariesSearch),
  head: () => ({ meta: [{ title: "Libraries · [movies]" }] }),
  component: LibrariesPage,
});

function LibrariesPage() {
  const { dialog } = Route.useSearch();
  const navigate = Route.useNavigate();

  return (
    <ScopeGate scopes={["manage"]}>
      <LibrariesScreen
        adding={dialog === "add"}
        onAddingChange={(open) =>
          void navigate({ search: open ? { dialog: "add" } : {}, replace: true })
        }
      />
    </ScopeGate>
  );
}
