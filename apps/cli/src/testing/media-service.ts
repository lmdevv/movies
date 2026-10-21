/** A stand-in media service on a free local port, for commands that call it over HTTP. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";

import { Predicate } from "effect";

/** Serves every request with `handler` while `use` runs with the service's URL, then closes it. */
export const withMediaService = async <A>(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  use: (url: string) => Promise<A>,
): Promise<A> => {
  const server = createServer(handler);

  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  const address = server.address();

  if (address === null || Predicate.isString(address)) throw new Error("Not listening on TCP");

  try {
    return await use(`http://127.0.0.1:${String(address.port)}`);
  } finally {
    server.closeAllConnections();
    await new Promise((closed) => server.close(closed));
  }
};
