/**
 * A Plex Media Server stand-in: responses written from Plex's published API documentation (a real
 * server needs a plex.tv claim), replayed by a local HTTP server. `FIXTURE_PLEX_TOKEN` is the
 * server owner's token; `FIXTURE_SHARED_TOKEN` belongs to a user the server is shared with.
 */
import { Schema } from "effect";

import recorded from "../fixtures/plex.json" with { type: "json" };
import type { Identity, RecordedServer, Recordings } from "./recorded-server.ts";
import { Recording, startRecordedServer } from "./recorded-server.ts";

/** The server owner's token. */
export const FIXTURE_PLEX_TOKEN = "fixture-plex-token";

/** A shared user's token: it signs in, but may not list the server's accounts. */
export const FIXTURE_SHARED_TOKEN = "fixture-shared-token";

const plexIdentity: Identity = {
  tokenOf: (request) => {
    const token = request.headers["x-plex-token"];

    return Array.isArray(token) ? (token[0] ?? null) : (token ?? null);
  },
  labelOf: (token) => {
    if (token === FIXTURE_PLEX_TOKEN) return "owner";

    return token === FIXTURE_SHARED_TOKEN ? "shared" : null;
  },
};

const RecordedFile = Schema.Struct({
  recordings: Schema.Record(Schema.String, Recording),
});

const plexRecordings: Recordings = Schema.decodeSync(RecordedFile)(recorded).recordings;

/** Starts the Plex stand-in, optionally with some responses replaced. */
export const startPlexFixture = (overrides: Recordings = {}): Promise<RecordedServer> =>
  startRecordedServer({ ...plexRecordings, ...overrides }, plexIdentity);
