import { Option, Schema } from "effect";

import type { ServerConnection } from "./discovery";
import { readValue, writeValue } from "./secure-storage";

export type { ServerConnection } from "./discovery";

const StoredConnection = Schema.fromJsonString(
  Schema.Struct({ mediaUrl: Schema.String, convexUrl: Schema.String }),
);

const KEY = "movies.server";

const decodeStored = Schema.decodeUnknownOption(StoredConnection);

const encodeStored = Schema.encodeSync(StoredConnection);

/** The connection this install remembers, if any. */
export const loadConnection = (): ServerConnection | null => {
  const stored = readValue(KEY);

  return stored === null ? null : Option.getOrNull(decodeStored(stored));
};

/** Remembers a connection, or forgets it with null. */
export const saveConnection = (connection: ServerConnection | null): void => {
  writeValue(KEY, connection === null ? null : encodeStored(connection));
};
