import { MoviesProvider } from "@movies/sdk/react";
import { Spinner } from "@movies/ui/components/spinner";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { ConvexReactClient } from "convex/react";
import { StrictMode } from "react";
import type { ReactNode } from "react";
import ReactDOM from "react-dom/client";

import { ENV, MEDIA_BASE_URL } from "./env";
import { parseSearch, stringifySearch } from "./lib/search-params";
import { routeTree } from "./routeTree.gen";
import { ProfileChoiceProvider } from "./session/profile-choice";

const convex = new ConvexReactClient(ENV.VITE_CONVEX_URL);

const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  scrollRestoration: true,
  // Search values stay plain strings; each route reads its own.
  parseSearch,
  stringifySearch,
  defaultPendingComponent: () => (
    <div className="flex min-h-svh items-center justify-center bg-page">
      <Spinner className="size-12 text-text" label="Loading" />
    </div>
  ),
  context: {},
  Wrap: function Providers({ children }: { readonly children: ReactNode }) {
    return (
      <MoviesProvider client={convex} storage={window.localStorage} mediaUrl={MEDIA_BASE_URL}>
        <ProfileChoiceProvider>{children}</ProfileChoiceProvider>
      </MoviesProvider>
    );
  },
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const rootElement = document.getElementById("app");

if (!rootElement) {
  throw new Error("Root element not found");
}

if (!rootElement.innerHTML) {
  const root = ReactDOM.createRoot(rootElement);
  root.render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  );
}
