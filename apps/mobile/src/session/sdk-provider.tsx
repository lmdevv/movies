/**
 * Opens the SDK on the connected server: one Convex client (and WebSocket) for the app's lifetime
 * on that server, with the session kept in the keychain.
 */
import { MoviesProvider } from "@movies/sdk/react";
import { ConvexReactClient } from "convex/react";
import { useEffect, useMemo } from "react";
import type { ReactNode } from "react";

import type { ServerConnection } from "@/lib/connection";
import { sessionStore } from "@/lib/secure-storage";

/** The SDK and Convex client for `connection`, provided to everything below. */
export function SdkProvider({
  connection,
  children,
}: {
  readonly connection: ServerConnection;
  readonly children: ReactNode;
}) {
  // React Native has no page to unload, so the browser's unsaved-changes prompt is off.
  const client = useMemo(
    () => new ConvexReactClient(connection.convexUrl, { unsavedChangesWarning: false }),
    [connection.convexUrl],
  );

  useEffect(
    () => () => {
      void client.close();
    },
    [client],
  );

  return (
    <MoviesProvider client={client} mediaUrl={connection.mediaUrl} storage={sessionStore}>
      {children}
    </MoviesProvider>
  );
}
