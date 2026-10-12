/**
 * The recorded Jellyfin server: responses recorded from a real Jellyfin (see
 * `scripts/record-jellyfin-fixtures.ts`), replayed by a local HTTP server. Callers sign in with
 * `FIXTURE_API_KEY` or with the recorded users' passwords.
 */
import { Schema } from "effect";

import recorded from "../fixtures/jellyfin.json" with { type: "json" };
import type { Identity, RecordedServer } from "./recorded-server.ts";
import { Recording, startRecordedServer } from "./recorded-server.ts";

/**
 * The password the recordings accept for `user`: a fixture value, not a secret. The live server's
 * passwords are random; the recorder records sign-ins as if these had been sent.
 */
export const fixturePassword = (user: string): string => `${user}-pass`;

/** The API key the recordings accept. */
export const FIXTURE_API_KEY = "fixture-api-key";

const TOKEN = /Token="([^"]*)"/u;

/** Tells callers apart by the token in Jellyfin's `Authorization: MediaBrowser ...` header. */
export const jellyfinIdentity: Identity = {
  tokenOf: (request) => {
    const header = request.headers.authorization ?? "";

    return TOKEN.exec(header)?.[1] ?? null;
  },
  labelOf: (token) => {
    if (token === FIXTURE_API_KEY) return "apikey";

    return token.startsWith("fixture-token-") ? token.slice("fixture-token-".length) : null;
  },
};

const RecordedFile = Schema.Struct({
  version: Schema.String,
  ids: Schema.Record(Schema.String, Schema.String),
  recordings: Schema.Record(Schema.String, Recording),
});

/** The recordings and the IDs the recorded server gave its users and items. */
export const jellyfinRecording = Schema.decodeSync(RecordedFile)(recorded);

/** Starts the recorded Jellyfin server. */
export const startJellyfinFixture = (): Promise<RecordedServer> =>
  startRecordedServer(jellyfinRecording.recordings, jellyfinIdentity);
