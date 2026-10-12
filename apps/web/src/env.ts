import { Schema } from "effect";

const WebEnv = Schema.Struct({
  VITE_CONVEX_URL: Schema.NonEmptyString,
  /**
   * The media service URL for artwork and `media` commands. Optional: in production the media
   * service serves this app, so artwork loads from the same origin.
   */
  VITE_MEDIA_BASE_URL: Schema.optionalKey(Schema.String),
});

export const ENV = Schema.decodeUnknownSync(WebEnv)(import.meta.env);

const configuredMediaUrl = ENV.VITE_MEDIA_BASE_URL?.replace(/\/+$/u, "") ?? "";

/** Where artwork and media requests go: the configured media service, or this app's origin. */
export const MEDIA_BASE_URL =
  configuredMediaUrl === "" ? window.location.origin : configuredMediaUrl;
