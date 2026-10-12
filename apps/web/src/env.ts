import { Schema } from "effect";

const WebEnv = Schema.Struct({
  VITE_CONVEX_URL: Schema.NonEmptyString,
  /** The media service URL for `media` commands and health; omitted when it serves this app. */
  VITE_MEDIA_BASE_URL: Schema.optionalKey(Schema.NonEmptyString),
});

export const ENV = Schema.decodeUnknownSync(WebEnv)(import.meta.env);
