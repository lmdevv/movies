import { Schema } from "effect";

const WebEnv = Schema.Struct({
  VITE_CONVEX_URL: Schema.NonEmptyString,
  VITE_MEDIA_BASE_URL: Schema.optionalKey(Schema.String),
});

export const ENV = Schema.decodeUnknownSync(WebEnv)(import.meta.env);

const configuredMediaUrl = ENV.VITE_MEDIA_BASE_URL?.replace(/\/+$/u, "") ?? "";

/** Where artwork and media requests go: the configured media service, or this app's origin. */
export const MEDIA_BASE_URL =
  configuredMediaUrl === "" ? window.location.origin : configuredMediaUrl;
