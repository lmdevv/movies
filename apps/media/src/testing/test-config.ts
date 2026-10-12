/** Media configuration and playback tokens for tests, built through the real config decoding. */
import { createHmac } from "node:crypto";

import { ConfigProvider, Layer } from "effect";

import * as MediaConfig from "../media-config.ts";

/** The 32-byte playback token secret tests sign with, as raw bytes. */
const testSecretBytes = Buffer.alloc(32, 9);

/**
 * `MediaConfig` decoded from an environment record, with defaults for the required names.
 * `overrides` replace defaults; pass `DATA_DIR`, `TRANSCODE_DIR`, and `LIBRARY_ROOTS` for tests
 * that touch the disk.
 */
export const testConfigLayer = (
  overrides: Readonly<Record<string, string>>,
): Layer.Layer<MediaConfig.Service> =>
  MediaConfig.layer.pipe(
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: {
            MEDIA_BASE_URL: "http://127.0.0.1:4300",
            PLAYBACK_TOKEN_SECRET: testSecretBytes.toString("base64url"),
            LIBRARY_ROOTS: "/nonexistent",
            DATA_DIR: "/nonexistent/data",
            TRANSCODE_DIR: "/nonexistent/transcode",
            HARDWARE_ACCELERATION: "none",
            ...overrides,
          },
        }),
      ),
    ),
    Layer.orDie,
  );

/** Claims of a test playback token; times are milliseconds since the epoch. */
export interface TestTokenClaims {
  readonly fid: string;
  readonly sid?: string;
  readonly aud?: string;
  readonly exp?: number;
}

/** Signs a playback token the way Convex does, with Node's HMAC and the test secret. */
export const signTestToken = (claims: TestTokenClaims): string => {
  const payload = Buffer.from(
    JSON.stringify({
      aud: claims.aud ?? "media",
      sub: "user_test",
      pid: "profile_test",
      fid: claims.fid,
      sid: claims.sid ?? "session_test",
      iat: Date.now(),
      exp: claims.exp ?? Date.now() + 6 * 60 * 60 * 1000,
    }),
  ).toString("base64url");

  const signature = createHmac("sha256", testSecretBytes)
    .update(`v1.${payload}`)
    .digest("base64url");

  return `v1.${payload}.${signature}`;
};
