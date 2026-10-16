/** The Convex client for the remembered server, opened while a screen needs it. */
import { ConvexReactClient } from "convex/react";
import { useEffect, useState } from "react";

/**
 * A Convex client for `url`, or null until it is open. It is created and closed by one effect, so
 * a development double mount never leaves a closed client in use, and a new URL replaces it.
 */
export const useConvexClient = (url: string | null): ConvexReactClient | null => {
  const [client, setClient] = useState<ConvexReactClient | null>(null);

  useEffect(() => {
    if (url === null) return undefined;

    const created = new ConvexReactClient(url, { unsavedChangesWarning: false });

    setClient(created);

    return () => {
      setClient(null);
      void created.close();
    };
  }, [url]);

  return client;
};
