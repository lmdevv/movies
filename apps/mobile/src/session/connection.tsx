/**
 * The server connection for the whole app. Screens before connecting read and change it here;
 * once set, the app opens the SDK on it.
 */
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { loadConnection, saveConnection } from "@/lib/connection";
import type { ServerConnection } from "@/lib/connection";
import { saveProfileChoice } from "@/lib/profile-store";

/** The connection and the ways to change it. */
export interface ConnectionState {
  /** Where the app connects, or null before anyone connected this install. */
  readonly connection: ServerConnection | null;
  /** Remembers a server and opens the app on it. */
  readonly connect: (connection: ServerConnection) => void;
  /** Forgets the server, back to the welcome screen. */
  readonly disconnect: () => void;
}

const ConnectionContext = createContext<ConnectionState | null>(null);

/** Holds the connection, starting from the one this install remembers. */
export function ConnectionProvider({ children }: { readonly children: ReactNode }) {
  const [connection, setConnection] = useState<ServerConnection | null>(loadConnection);

  const connect = useCallback((next: ServerConnection) => {
    saveConnection(next);
    setConnection(next);
  }, []);

  const disconnect = useCallback(() => {
    saveConnection(null);
    // Profiles belong to the server's accounts; another server must not inherit the choice.
    saveProfileChoice(null);
    setConnection(null);
  }, []);

  const value = useMemo(
    () => ({ connection, connect, disconnect }),
    [connection, connect, disconnect],
  );

  return <ConnectionContext.Provider value={value}>{children}</ConnectionContext.Provider>;
}

/**
 * The app's server connection.
 *
 * @throws When used outside `ConnectionProvider`, a programming error.
 */
export const useConnection = (): ConnectionState => {
  const state = useContext(ConnectionContext);

  if (state === null) throw new Error("useConnection must be used inside ConnectionProvider");

  return state;
};

/**
 * The connected server. Use only below the connected part of the app.
 *
 * @throws When no server is connected, a programming error.
 */
export const useServer = (): ServerConnection => {
  const { connection } = useConnection();

  if (connection === null) throw new Error("useServer must be used once a server is connected");

  return connection;
};
