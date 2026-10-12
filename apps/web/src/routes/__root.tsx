import { Toaster } from "@movies/ui/components/sonner";
import { HeadContent, Outlet, createRootRouteWithContext } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";

import { ThemeProvider } from "@/components/theme-provider";

import "../index.css";

/** Values every route can read from the router context. */
export interface RouterAppContext {}

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    /** The route opens on a full-bleed billboard, so the desktop top bar floats over it. */
    readonly hero?: boolean;
  }
}

export const Route = createRootRouteWithContext<RouterAppContext>()({
  component: RootComponent,
  head: () => ({
    meta: [
      { title: "[movies]" },
      { name: "description", content: "Your movies and shows, streamed from your own library" },
    ],
    links: [{ rel: "icon", href: "/favicon.ico" }],
  }),
});

function RootComponent() {
  return (
    <>
      <HeadContent />
      <ThemeProvider
        attribute="class"
        defaultTheme="dark"
        disableTransitionOnChange
        storageKey="movies-theme"
      >
        <Outlet />
        <Toaster />
      </ThemeProvider>
      {import.meta.env.DEV ? <TanStackRouterDevtools position="bottom-left" /> : null}
    </>
  );
}
