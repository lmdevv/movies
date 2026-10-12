/** Opaque identifiers the media service receives from Convex or mints for its own streams. */
import { Schema } from "effect";

/** Convex ID of a media file record; also the `fid` claim of a playback token. */
export const FileId = Schema.NonEmptyString.pipe(Schema.brand("FileId"));

/** Convex ID of a media file record. */
export type FileId = typeof FileId.Type;

/** Convex ID of a library, one approved folder scanned as a unit. */
export const LibraryId = Schema.NonEmptyString.pipe(Schema.brand("LibraryId"));

/** Convex ID of a library. */
export type LibraryId = typeof LibraryId.Type;

/** Convex ID of a per-device playback session; the `sid` claim of a playback token. */
export const PlaybackSessionId = Schema.NonEmptyString.pipe(Schema.brand("PlaybackSessionId"));

/** Convex ID of a per-device playback session. */
export type PlaybackSessionId = typeof PlaybackSessionId.Type;

/** Convex Auth user ID; the `sub` claim of a playback token. */
export const UserId = Schema.NonEmptyString.pipe(Schema.brand("UserId"));

/** Convex Auth user ID. */
export type UserId = typeof UserId.Type;

/** Convex ID of a viewing profile; the `pid` claim of a playback token. */
export const ProfileId = Schema.NonEmptyString.pipe(Schema.brand("ProfileId"));

/** Convex ID of a viewing profile. */
export type ProfileId = typeof ProfileId.Type;

/**
 * Random identifier of one HLS stream session that this media service process owns. It is not
 * stored anywhere, so a restarted service does not recognise identifiers it handed out before.
 */
export const StreamId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{22}$/)).pipe(
  Schema.brand("StreamId"),
);

/** Random identifier of one HLS stream session. */
export type StreamId = typeof StreamId.Type;
