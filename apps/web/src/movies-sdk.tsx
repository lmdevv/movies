import { MoviesProvider } from "@movies/sdk/react";
import type { ConvexReactClient } from "convex/react";
import type { ReactNode } from "react";

import { ENV } from "./env";

/**
 * Where the media service answers: the configured URL in development, otherwise this origin,
 * because the media service serves the built app.
 */
export const MEDIA_URL = ENV.VITE_MEDIA_BASE_URL ?? window.location.origin;

/** Provides the SDK over the app's Convex client, keeping the session in `localStorage`. */
export function SdkProvider({
  client,
  children,
}: {
  readonly client: ConvexReactClient;
  readonly children: ReactNode;
}) {
  return (
    <MoviesProvider client={client} mediaUrl={MEDIA_URL} storage={window.localStorage}>
      {children}
    </MoviesProvider>
  );
}
