import type { Server, ServerResponse } from "node:http";
import { createServer } from "node:http";

import { Effect, Predicate } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addressCandidates, lookup } from "./server-lookup";

const health = {
  status: "ok",
  activeStreams: 0,
  hardwareAcceleration: "none",
  backend: "connected",
};

const respond = (response: ServerResponse, status: number, json: string): void => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(json);
};

/** A media service answering health and client configuration with `convexUrl`. */
const mediaService = (convexUrl: string | null): Server =>
  createServer((request, response) => {
    if (request.url === "/api/health") return respond(response, 200, JSON.stringify(health));

    if (request.url === "/api/client-config") {
      return respond(response, 200, JSON.stringify({ convexUrl }));
    }

    return respond(response, 404, "");
  });

/** Something else on the network: a web server that answers every path with a page. */
const otherService = (): Server =>
  createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<html></html>");
  });

const listen = async (server: Server): Promise<string> => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  if (address === null || Predicate.isString(address)) throw new Error("The server is not on TCP");

  return `127.0.0.1:${String(address.port)}`;
};

const servers = {
  ready: mediaService("http://convex.home.lan:3210"),
  unconfigured: mediaService(null),
  other: otherService(),
};

const hosts = { ready: "", unconfigured: "", other: "" };

beforeAll(async () => {
  hosts.ready = await listen(servers.ready);
  hosts.unconfigured = await listen(servers.unconfigured);
  hosts.other = await listen(servers.other);
});

afterAll(() => {
  for (const server of Object.values(servers)) server.close();
});

const run = (address: string) => Effect.runPromise(Effect.result(lookup(address)));

describe("addressCandidates", () => {
  it("tries https first for names and adds the default port", () => {
    expect(addressCandidates(" movies.home.lan ")).toStrictEqual([
      "https://movies.home.lan",
      "http://movies.home.lan",
      "http://movies.home.lan:8080",
    ]);
  });

  it("tries http first for addresses and local names", () => {
    expect(addressCandidates("192.168.1.20:3001")).toStrictEqual([
      "http://192.168.1.20:3001",
      "https://192.168.1.20:3001",
    ]);
    expect(addressCandidates("nas.local")).toStrictEqual([
      "http://nas.local",
      "https://nas.local",
      "http://nas.local:8080",
    ]);
  });

  it("keeps an explicit URL and its path prefix, without trailing slashes", () => {
    expect(addressCandidates("https://nas.tailnet.ts.net/movies/?x=1#top")).toStrictEqual([
      "https://nas.tailnet.ts.net/movies",
    ]);
  });

  it("refuses text that cannot be a server", () => {
    expect(addressCandidates("")).toStrictEqual([]);
    expect(addressCandidates("ftp://nas")).toStrictEqual([]);
    expect(addressCandidates("http://user:secret@nas")).toStrictEqual([]);
    expect(addressCandidates("not a host")).toStrictEqual([]);
  });
});

describe("lookup", () => {
  it("finds the media service and the Convex URL it hands out", async () => {
    const result = await run(hosts.ready);

    expect(result).toMatchObject({
      _tag: "Success",
      success: { mediaUrl: `http://${hosts.ready}`, convexUrl: "http://convex.home.lan:3210" },
    });
  });

  it("says when the server has no Convex URL for apps", async () => {
    const result = await run(`http://${hosts.unconfigured}`);

    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ServerNotReady", mediaUrl: `http://${hosts.unconfigured}` },
    });
  });

  it("does not take another web server for a media service", async () => {
    const result = await run(`http://${hosts.other}`);

    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ServerUnreachable" } });
  });

  it("refuses an address it cannot read", async () => {
    const result = await run("   ");

    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "InvalidAddress" } });
  });
});
