/**
 * Verifies the playback tokens Convex issues with the shared verifier in
 * `@movies/contracts/playback-token` (format in `docs/decisions.md`), then refuses tokens whose
 * playback session has ended. Tokens are `Redacted` from the HTTP boundary to here and never
 * appear in errors or logs.
 */
import type { MediaFileId, PlaybackSessionId, ProfileId, UserId } from "@movies/contracts/ids";
import { PlaybackSessionEnded } from "@movies/contracts/media-playback";
import {
  importPlaybackTokenSecret,
  type PlaybackTokenInvalid,
  type PlaybackTokenSecretInvalid,
  verifyPlaybackToken,
} from "@movies/contracts/playback-token";
import { Context, Effect, Layer, Redacted } from "effect";

import * as MediaConfig from "../media-config.ts";
import * as EndedSessions from "./ended-sessions.ts";

/** What a verified token allows: one profile playing one file in one playback session. */
export interface PlaybackGrant {
  readonly userId: UserId;
  readonly profileId: ProfileId;
  readonly fileId: MediaFileId;
  readonly sessionId: PlaybackSessionId;
  /** Expiry in milliseconds since the epoch. */
  readonly expiresAt: number;
}

/** Checks playback tokens. */
export interface Interface {
  /**
   * The grant of a valid token. Fails with `PlaybackTokenInvalid` for a malformed, forged,
   * expired, or misaddressed token, and `PlaybackSessionEnded` once its session ended.
   */
  readonly verify: (
    token: Redacted.Redacted,
  ) => Effect.Effect<PlaybackGrant, PlaybackTokenInvalid | PlaybackSessionEnded>;
}

/** The playback token verifier. */
export class Service extends Context.Service<Service, Interface>()(
  "@movies/media/PlaybackTokenVerifier",
) {}

/** Builds a verifier for tokens signed with `secret`. */
export const make = Effect.fn("PlaybackTokenVerifier.make")(function* (
  secret: Redacted.Redacted,
): Effect.fn.Return<Interface, PlaybackTokenSecretInvalid, EndedSessions.Service> {
  const key = yield* importPlaybackTokenSecret(secret);
  const ended = yield* EndedSessions.Service;

  const verify = Effect.fn("PlaybackTokenVerifier.verify")(function* (token: Redacted.Redacted) {
    const payload = yield* verifyPlaybackToken(key, Redacted.value(token));

    if (yield* ended.isEnded(payload.sid)) {
      return yield* new PlaybackSessionEnded({ sessionId: payload.sid });
    }

    return {
      userId: payload.sub,
      profileId: payload.pid,
      fileId: payload.fid,
      sessionId: payload.sid,
      expiresAt: payload.exp,
    } satisfies PlaybackGrant;
  });

  return Service.of({ verify });
});

/** Verifies tokens with `PLAYBACK_TOKEN_SECRET` from the media configuration. */
export const layer: Layer.Layer<
  Service,
  PlaybackTokenSecretInvalid,
  MediaConfig.Service | EndedSessions.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* MediaConfig.Service;

    return yield* make(config.playbackTokenSecret);
  }),
);
