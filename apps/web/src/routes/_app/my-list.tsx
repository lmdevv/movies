import { createFileRoute } from "@tanstack/react-router";

// Rows arrive with the data milestone; until then the shell renders an empty page.
export const Route = createFileRoute("/_app/my-list")({
  component: MyListPage,
});

function MyListPage() {
  return null;
}
