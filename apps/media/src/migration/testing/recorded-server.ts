import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { Option, Predicate, Schema } from "effect";

/** One recorded response: a JSON body, or the raw text (`raw`) of a body that is not JSON. */
export const Recording = Schema.Struct({
  status: Schema.Int,
  body: Schema.Json,
  raw: Schema.optionalKey(Schema.Boolean),
});

/** One recorded response. */
export interface Recording extends Schema.Schema.Type<typeof Recording> {}

/** Recordings by request key. */
export type Recordings = Readonly<Record<string, Recording>>;

interface ReceivedRequest {
  readonly method: string;
  readonly path: string;
  readonly label: string;
}

/** How callers are told apart. */
export interface Identity {
  /** The caller's token, if any, from the request headers. */
  readonly tokenOf: (request: IncomingMessage) => string | null;
  /** The label of a known token; null makes the server answer 401. */
  readonly labelOf: (token: string) => string | null;
}

/** A running recorded server. */
export interface RecordedServer {
  readonly url: string;
  readonly requests: ReadonlyArray<ReceivedRequest>;
  readonly close: () => Promise<void>;
}

const readBody = (request: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Array<Buffer> = [];

    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", reject);
  });

const requestKey = (label: string, method: string, url: URL, body: string): string => {
  const query = [...url.searchParams.entries()]
    .map(([key, value]) => `${key.toLowerCase()}=${value}`)
    .toSorted()
    .join("&");

  const hash =
    body === "" ? "" : `#${createHash("sha256").update(body).digest("hex").slice(0, 12)}`;

  return `${label}|${method} ${url.pathname}${query === "" ? "" : `?${query}`}${hash}`;
};

const listen = (server: Server): Promise<string> =>
  new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      if (address === null || Predicate.isString(address)) {
        reject(new Error("The fixture server is not listening on a TCP port"));
      } else {
        resolve(`http://127.0.0.1:${String(address.port)}`);
      }
    });
  });

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => {
      resolve();
    });
  });

/** Starts a server replaying `recordings`. */
export const startRecordedServer = async (
  recordings: Recordings,
  identity: Identity,
): Promise<RecordedServer> => {
  const requests: Array<ReceivedRequest> = [];

  const respond = async (request: IncomingMessage, response: ServerResponse) => {
    const body = await readBody(request);
    const url = new URL(request.url ?? "/", "http://fixture.invalid");
    const method = request.method ?? "GET";
    const token = identity.tokenOf(request);
    const label = token === null ? "-" : identity.labelOf(token);

    requests.push({ method, path: url.pathname, label: label ?? "?" });

    const recorded = label === null ? undefined : recordings[requestKey(label, method, url, body)];
    const status = label === null ? 401 : (recorded?.status ?? 404);

    response.writeHead(status, { "content-type": "application/json" });

    if (recorded === undefined) response.end("");
    else if (recorded.raw === true && Predicate.isString(recorded.body))
      response.end(recorded.body);
    else response.end(JSON.stringify(recorded.body));
  };

  const server = createServer((request, response) => {
    void respond(request, response);
  });

  const url = await listen(server);

  return { url, requests, close: () => closeServer(server) };
};

const parseJson = (text: string): Option.Option<Schema.Json> =>
  text === "" ? Option.some(null) : Schema.decodeOption(Schema.fromJsonString(Schema.Json))(text);

/** A recording proxy and what it saw. */
export interface Recorder {
  readonly url: string;
  readonly recordings: () => Recordings;
  readonly close: () => Promise<void>;
}

/** A sign-in the recorder saw: whose it was and the token it returned. */
export interface SignIn {
  readonly user: string;
  readonly token: string;
}

/**
 * Starts a proxy to `upstream` that records every exchange. `tokens` names the tokens known up
 * front (such as an API key); sign-ins teach it the rest, through `signIn`, which reads a sign-in
 * request and response and returns the user name and the token to replace. Request bodies are
 * keyed with each of `replacements` (such as a live password) replaced by its stand-in.
 */
export const startRecorder = async (
  upstream: string,
  identity: Pick<Identity, "tokenOf">,
  tokens: ReadonlyMap<string, string>,
  signIn: (
    path: string,
    requestBody: string,
    responseBody: Option.Option<Schema.Json>,
  ) => SignIn | null,
  replacements: ReadonlyMap<string, string>,
): Promise<Recorder> => {
  const labels = new Map(tokens);
  const recordings: Record<string, Recording> = {};

  const respond = async (request: IncomingMessage, response: ServerResponse) => {
    const body = await readBody(request);
    const url = new URL(request.url ?? "/", upstream);
    const method = request.method ?? "GET";
    const headers = new Headers();

    for (const [name, value] of Object.entries(request.headers)) {
      if (Predicate.isString(value) && name !== "host") headers.set(name, value);
    }

    const answer = await fetch(new URL(`${url.pathname}${url.search}`, upstream), {
      method,
      headers,
      body: body === "" ? null : body,
    });

    const text = await answer.text();
    const signedIn = signIn(url.pathname, body, parseJson(text));
    let stored = text;

    if (signedIn !== null) {
      labels.set(signedIn.token, signedIn.user);
      stored = text.replaceAll(signedIn.token, `fixture-token-${signedIn.user}`);
    }

    const token = identity.tokenOf(request);
    const label = token === null ? "-" : (labels.get(token) ?? "?");

    const keyedBody = [...replacements].reduce(
      (keyed, [secret, standIn]) => keyed.replaceAll(secret, standIn),
      body,
    );

    recordings[requestKey(label, method, url, keyedBody)] = Option.match(parseJson(stored), {
      onNone: (): Recording => ({ status: answer.status, body: stored, raw: true }),
      onSome: (json): Recording => ({ status: answer.status, body: json }),
    });

    response.writeHead(answer.status, { "content-type": "application/json" });
    response.end(text);
  };

  const server = createServer((request, response) => {
    void respond(request, response);
  });

  const url = await listen(server);

  return { url, recordings: () => recordings, close: () => closeServer(server) };
};
