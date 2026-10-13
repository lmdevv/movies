/**
 * A TCP proxy in front of a real service, for tests of what happens when the network misbehaves:
 * `refuse` closes every new connection at once (the service is down), `blackhole` accepts and
 * forwards nothing (a hung server or a dead route), and `drop` cuts every open connection (a
 * restart or a network blip). Effect-free, like the other process helpers.
 */
import { createServer, type Server, type Socket, connect } from "node:net";

/** How the proxy treats new connections. */
type ProxyMode = "open" | "refuse" | "blackhole";

/** A running proxy. */
export interface TcpProxy {
  readonly port: number;
  readonly setMode: (mode: ProxyMode) => void;
  /** Cuts every open connection. */
  readonly drop: () => void;
  readonly close: () => Promise<void>;
}

/** Starts a proxy on a free local port that forwards to `target` (`host:port`). */
export const startTcpProxy = async (target: URL): Promise<TcpProxy> => {
  let mode: ProxyMode = "open";
  const sockets = new Set<Socket>();

  const track = (socket: Socket): void => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
  };

  const server: Server = createServer((client) => {
    track(client);

    if (mode === "refuse") {
      client.destroy();

      return;
    }

    if (mode === "blackhole") return;

    const upstream = connect(Number(target.port), target.hostname);

    track(upstream);
    client.pipe(upstream);
    upstream.pipe(client);
    upstream.on("close", () => client.destroy());
    client.on("close", () => upstream.destroy());
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  const port = address instanceof Object ? address.port : 0;

  const drop = (): void => {
    for (const socket of sockets) socket.destroy();
  };

  return {
    port,
    setMode: (next) => {
      mode = next;
    },
    drop,
    close: () => {
      drop();

      return new Promise((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
};
