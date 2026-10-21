import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";

import { Effect, Option, Predicate, Redacted, Schema, Stream } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { StreamGenerationGone } from "@movies/contracts/media-playback";
import { PlaybackTokenInvalid } from "@movies/contracts/playback-token";

import type { MediaRequest } from "./media-http";
import { requestJson, requestLines, requestPlayback } from "./media-http";
import { recoveryFor } from "./playback";

const received: Array<{
  readonly url: string;
  readonly auth: string | undefined;
  readonly body: string;
}> = [];

const respond = (response: ServerResponse, status: number, body: string): void => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(body);
};

const route = (path: string, response: ServerResponse): void => {
  switch (path) {
    case "/ok":
      return respond(response, 200, JSON.stringify({ ok: true }));
    case "/failure":
      return respond(response, 403, JSON.stringify({ code: "forbidden", message: "Admins only" }));
    case "/tagged":
      return respond(response, 422, JSON.stringify({ _tag: "UnsupportedPlayback", reason: "x" }));
    case "/gone":
      return respond(
        response,
        410,
        JSON.stringify({
          _tag: "StreamGenerationGone",
          streamId: "abc",
          generation: 1,
          currentGeneration: 2,
        }),
      );
    case "/expired":
      return respond(
        response,
        401,
        JSON.stringify({ _tag: "PlaybackTokenInvalid", reason: "expired", message: "expired" }),
      );
    case "/lines":
      response.writeHead(200, { "content-type": "application/x-ndjson", "x-test": "yes" });
      response.end('{"n":1}\n{"n":2}\n');

      return;
    case "/gateway":
      return respond(response, 502, "<html>Bad gateway</html>");
    case "/garbage":
      return respond(response, 200, "<html>");
    case "/wrong":
      return respond(response, 200, JSON.stringify({ ok: "yes" }));
    default:
      return respond(response, 404, "");
  }
};

const server = createServer((request: IncomingMessage, response: ServerResponse) => {
  let body = "";

  request.on("data", (chunk: Buffer) => {
    body += chunk.toString("utf8");
  });

  request.on("end", () => {
    received.push({ url: request.url ?? "", auth: request.headers.authorization, body });
    route(request.url ?? "", response);
  });
});

let base = "";

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  if (address === null || Predicate.isString(address)) throw new Error("The server is not on TCP");

  base = `http://127.0.0.1:${String(address.port)}`;
});

afterAll(() => {
  server.close();
});

const Ok = Schema.Struct({ ok: Schema.Literal(true) });

const request = (path: string): MediaRequest => ({
  operation: "test.call",
  url: `${base}${path}`,
  method: "POST",
  body: Option.some({ hello: "world" }),
  bearer: Option.some(Redacted.make("secret-jwt")),
});

const outcome = (path: string) => Effect.runPromise(Effect.result(requestJson(request(path), Ok)));

describe("media service requests", () => {
  it("sends the JSON body and bearer token and decodes the answer", async () => {
    const result = await outcome("/ok");

    expect(result).toMatchObject({ _tag: "Success", success: { ok: true } });
    expect(received.at(-1)).toMatchObject({
      auth: "Bearer secret-jwt",
      body: JSON.stringify({ hello: "world" }),
    });
  });

  it("turns a { code, message } failure into its command error", async () => {
    expect(await outcome("/failure")).toMatchObject({
      failure: { _tag: "Forbidden", message: "Admins only" },
    });
  });

  it("maps a tagged HttpApi failure by status and names the tag", async () => {
    const result = await outcome("/tagged");

    expect(result).toMatchObject({ failure: { _tag: "InvalidArgs" } });
    expect(JSON.stringify(result)).toContain("UnsupportedPlayback");
  });

  it("reports bodies outside the contract as protocol errors", async () => {
    expect(await outcome("/garbage")).toMatchObject({ failure: { _tag: "ProtocolError" } });
    expect(await outcome("/wrong")).toMatchObject({ failure: { _tag: "ProtocolError" } });
  });

  it("reports an unreachable service as a transport error", async () => {
    const result = await Effect.runPromise(
      Effect.result(requestJson({ ...request("/ok"), url: "http://127.0.0.1:9/ok" }, Ok)),
    );

    expect(result).toMatchObject({ failure: { _tag: "TransportError" } });
  });
});

describe("line-by-line requests", () => {
  it("answers with the headers, then the lines as they arrive", async () => {
    const lines = await Effect.runPromise(
      Effect.flatMap(requestLines(request("/lines")), (answer) =>
        Stream.runCollect(answer.lines).pipe(
          Effect.map((collected) => ({ header: answer.headers.get("x-test"), collected })),
        ),
      ),
    );

    expect(lines).toStrictEqual({ header: "yes", collected: ['{"n":1}', '{"n":2}'] });
    expect(received.at(-1)).toMatchObject({ auth: "Bearer secret-jwt" });
  });

  it("fails like a command when the service refuses", async () => {
    const result = await Effect.runPromise(Effect.result(requestLines(request("/failure"))));

    expect(result).toMatchObject({ failure: { _tag: "Forbidden", message: "Admins only" } });
  });
});

const playbackOutcome = (path: string) =>
  Effect.runPromise(Effect.result(requestPlayback(request(path), Ok)));

describe("playback API requests", () => {
  it("decodes the playback API's tagged failures into their errors", async () => {
    const gone = await playbackOutcome("/gone");

    expect(gone).toMatchObject({
      failure: new StreamGenerationGone({ streamId: "abc", generation: 1, currentGeneration: 2 }),
    });

    const expired = await playbackOutcome("/expired");

    expect(expired).toMatchObject({
      failure: new PlaybackTokenInvalid({ reason: "expired", message: "expired" }),
    });
  });

  it("reports a gateway failure as an unreachable service and unknown bodies as protocol errors", async () => {
    expect(await playbackOutcome("/gateway")).toMatchObject({
      failure: { _tag: "TransportError" },
    });
    expect(await playbackOutcome("/failure")).toMatchObject({
      failure: { _tag: "ProtocolError" },
    });
  });

  it("says how a player recovers from each failure", () => {
    expect(
      recoveryFor(
        new StreamGenerationGone({ streamId: "abc", generation: 1, currentGeneration: 2 }),
      ),
    ).toBe("reload-playlist");
    expect(recoveryFor(new PlaybackTokenInvalid({ reason: "expired", message: "x" }))).toBe(
      "renew-token",
    );
    expect(recoveryFor(new PlaybackTokenInvalid({ reason: "bad_signature", message: "x" }))).toBe(
      "fail",
    );
  });
});
