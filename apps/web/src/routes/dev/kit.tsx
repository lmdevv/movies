import { createFileRoute } from "@tanstack/react-router";
import { Suspense, lazy } from "react";

// The component gallery exists only in development: in production builds the condition is the
// constant `false`, so the gallery module is never imported or bundled.
const Gallery = import.meta.env.DEV
  ? lazy(() => import("@/dev/kit-gallery").then((module) => ({ default: module.KitGallery })))
  : undefined;

export const Route = createFileRoute("/dev/kit")({
  component: KitPage,
});

function KitPage() {
  if (Gallery === undefined) return null;

  return (
    <Suspense fallback={null}>
      <Gallery />
    </Suspense>
  );
}
