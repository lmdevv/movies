import { Spinner } from "@movies/ui/components/spinner";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { ConvexReactClient } from "convex/react";
import ReactDOM from "react-dom/client";

import { ENV } from "./env";
import { SdkProvider } from "./movies-sdk";
import { routeTree } from "./routeTree.gen";

const convex = new ConvexReactClient(ENV.VITE_CONVEX_URL);

const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  scrollRestoration: true,
  defaultPendingComponent: () => (
    <div className="flex min-h-svh items-center justify-center bg-page">
      <Spinner className="size-12 text-text" label="Loading" />
    </div>
  ),
  context: {},
  Wrap: function WrapComponent({ children }: { children: React.ReactNode }) {
    return <SdkProvider client={convex}>{children}</SdkProvider>;
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
  root.render(<RouterProvider router={router} />);
}
