/**
 * Jellyfin and Plex migration. The media service talks to the source server; Convex records the
 * job and the imported watch state. Media files never move: [movies] adds the same folders.
 */
import { Schema } from "effect";

import { LibraryId, ProfileId } from "../ids";
import { MigrationSource } from "./jobs";

/** Arguments to connect to a source server. Credentials stay in the media service. */
export const MigrationConnectArgs = Schema.Struct({
  source: MigrationSource,
  url: Schema.String,
  /** A Jellyfin API key or a Plex token. Never logged or stored in Convex. */
  token: Schema.String,
});

/** A source user who can be mapped to a [movies] account. */
export const SourceUser = Schema.Struct({
  sourceUserId: Schema.String,
  name: Schema.String,
});

/** A source library and its folders as the source server reports them. */
export const SourceLibrary = Schema.Struct({
  sourceLibraryId: Schema.String,
  name: Schema.String,
  kind: Schema.Literals(["movies", "shows", "mixed", "other"]),
  paths: Schema.Array(Schema.String),
});

/** A connected source server. */
export const MigrationConnection = Schema.Struct({
  connectionId: Schema.String,
  source: MigrationSource,
  serverName: Schema.String,
  version: Schema.String,
  users: Schema.Array(SourceUser),
  libraries: Schema.Array(SourceLibrary),
});

/** A connected source server. */
export interface MigrationConnection extends Schema.Schema.Type<typeof MigrationConnection> {}

/** Which [movies] profile receives each source user's history. Unmapped users are skipped. */
export const UserMapping = Schema.Struct({
  sourceUserId: Schema.String,
  profileId: ProfileId,
});

/** Arguments for a dry run or an import. */
export const MigrationPlanArgs = Schema.Struct({
  connectionId: Schema.String,
  users: Schema.Array(UserMapping),
});

/** The dry-run summary the review screen shows before anything is written. */
export const MigrationReport = Schema.Struct({
  libraries: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      paths: Schema.Array(Schema.String),
      /** The [movies] library already covering these folders, or null when import will add one. */
      existingLibraryId: Schema.NullOr(LibraryId),
    }),
  ),
  matchedItems: Schema.Int,
  unmatchedItems: Schema.Int,
  watched: Schema.Int,
  inProgress: Schema.Int,
  favorites: Schema.Int,
  /** A few unmatched source paths, for the review screen. */
  unmatchedSamples: Schema.Array(Schema.String),
});

/** The dry-run summary. */
export interface MigrationReport extends Schema.Schema.Type<typeof MigrationReport> {}
