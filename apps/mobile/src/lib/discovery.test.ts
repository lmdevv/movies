import { createServer } from "node:http";
import type { Server } from "node:http";

import { Predicate } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { connectManually, discoverServer, normalizeServerUrl } from "./discovery";

/** A stand-in media service on a free port that answers `routes` with their JSON bodies. */
const serve = async (routes: Readonly<Record<string, string>>): Promise<Server> => {
  const server = createServer((request, response) => {
    const body = routes[request.url ?? ""];

    if (body === undefined) {
      response.writeHead(404).end();

      return;
    }

    response.writeHead(200, { "content-type": "application/json" }).end(body);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  return server;
};

const baseUrl = (server: Server): string => {
  const address = server.address();

  if (address === null || Predicate.isString(address)) throw new Error("Not listening on TCP");

  return `http://127.0.0.1:${address.port}`;
};

const health = JSON.stringify({
  status: "ok",
  activeStreams: 0,
  hardwareAcceleration: "none",
  backend: "connected",
});

const servers: Array<Server> = [];

const start = async (routes: Readonly<Record<string, string>>): Promise<string> => {
  const server = await serve(routes);

  servers.push(server);

  return baseUrl(server);
};

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

describe("normalizeServerUrl", () => {
  it("adds https, keeps paths, and drops trailing slashes", () => {
    expect(normalizeServerUrl(" cinema.home/ ")).toBe("https://cinema.home");
    expect(normalizeServerUrl("http://nas.local:8080/movies/")).toBe(
      "http://nas.local:8080/movies",
    );
  });

  it("refuses text that is not an http address", () => {
    expect(normalizeServerUrl("")).toBeNull();
    expect(normalizeServerUrl("ftp://cinema.home")).toBeNull();
    expect(normalizeServerUrl("http://")).toBeNull();
  });
});

describe("discoverServer", () => {
  it("finds the account server from the media address", async () => {
    const mediaUrl = await start({
      "/api/health": health,
      "/api/client-config": JSON.stringify({ convexUrl: "https://accounts.cinema.home" }),
    });

    expect(await discoverServer(`${mediaUrl}/`)).toEqual({
      ok: true,
      connection: { mediaUrl, convexUrl: "https://accounts.cinema.home" },
    });
  });

  it("reports a server without accounts as standalone", async () => {
    const mediaUrl = await start({ "/api/health": health, "/api/client-config": "{}" });

    expect(await discoverServer(mediaUrl)).toEqual({ ok: false, failure: "standalone" });
  });

  it("reports something that is not a media service as unreachable", async () => {
    const mediaUrl = await start({ "/api/health": JSON.stringify({ hello: "world" }) });

    expect(await discoverServer(mediaUrl)).toEqual({ ok: false, failure: "unreachable" });
  });

  it("falls back to http when an address without a scheme has no https", async () => {
    const mediaUrl = await start({
      "/api/health": health,
      "/api/client-config": JSON.stringify({ convexUrl: "http://127.0.0.1:3210" }),
    });

    expect(await discoverServer(mediaUrl.replace("http://", ""))).toEqual({
      ok: true,
      connection: { mediaUrl, convexUrl: "http://127.0.0.1:3210" },
    });
  });
});

describe("connectManually", () => {
  it("connects when both servers answer", async () => {
    const mediaUrl = await start({ "/api/health": health });
    const convexUrl = await start({ "/version": JSON.stringify("1.0") });

    expect(await connectManually(mediaUrl, convexUrl)).toEqual({
      ok: true,
      connection: { mediaUrl, convexUrl },
    });
  });

  it("refuses an account server that does not answer", async () => {
    const mediaUrl = await start({ "/api/health": health });

    expect(await connectManually(mediaUrl, "http://127.0.0.1:9")).toEqual({
      ok: false,
      failure: "unreachable",
    });
  });
});
