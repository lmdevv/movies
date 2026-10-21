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
  PlaybackTokenInvalid,
  type PlaybackTokenSecretInvalid,
  verifyPlaybackToken,
} from "@movies/contracts/playback-token";
import { Context, Effect, Layer, Redacted } from "effect";

import * as MediaConfig from "../media-config.ts";
import * as EndedSessions from "./ended-sessions.ts";

/** What a token is for: streaming a file, or downloading it to keep on a device. */
export type TokenPurpose = "play" | "download";

/** Routes only streaming serves: negotiation, seeking, HLS, and trickplay. */
export const PLAY: ReadonlyArray<TokenPurpose> = ["play"];

/** Routes only downloads use: preparing a download and its prepared MP4. */
export const DOWNLOAD: ReadonlyArray<TokenPurpose> = ["download"];

/** Routes both use: the original file and its subtitles. */
export const PLAY_OR_DOWNLOAD: ReadonlyArray<TokenPurpose> = ["play", "download"];

/** What a verified token allows: one profile playing one file in one playback session. */
export interface PlaybackGrant {
  readonly userId: UserId;
  readonly profileId: ProfileId;
  readonly fileId: MediaFileId;
  readonly sessionId: PlaybackSessionId;
  readonly purpose: TokenPurpose;
  /** Expiry in milliseconds since the epoch. */
  readonly expiresAt: number;
}

/** Checks playback tokens. */
export interface Interface {
  /**
   * The grant of a valid token for one of `purposes`. Fails with `PlaybackTokenInvalid` for a
   * malformed, forged, expired, or misaddressed token or one for another purpose, and
   * `PlaybackSessionEnded` once its session ended.
   */
  readonly verify: (
    token: Redacted.Redacted,
    purposes: ReadonlyArray<TokenPurpose>,
  ) => Effect.Effect<PlaybackGrant, PlaybackTokenInvalid | PlaybackSessionEnded>;
  /**
   * The grant of a valid streaming token, even once its session ended: a player's last reports
   * about a session arrive as it ends. Fails with `PlaybackTokenInvalid` like `verify`.
   */
  readonly verifyReport: (
    token: Redacted.Redacted,
  ) => Effect.Effect<PlaybackGrant, PlaybackTokenInvalid>;
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

  /** The grant of a token signed with the secret for one of `purposes`, ended or not. */
  const grantOf = Effect.fnUntraced(function* (
    token: Redacted.Redacted,
    purposes: ReadonlyArray<TokenPurpose>,
  ) {
    const payload = yield* verifyPlaybackToken(key, Redacted.value(token));
    const purpose = payload.pur ?? "play";

    if (!purposes.includes(purpose)) {
      return yield* new PlaybackTokenInvalid({
        reason: "wrong_purpose",
        message:
          purpose === "download"
            ? "A download token cannot stream"
            : "A playback token cannot download",
      });
    }

    return {
      userId: payload.sub,
      profileId: payload.pid,
      fileId: payload.fid,
      sessionId: payload.sid,
      purpose,
      expiresAt: payload.exp,
    } satisfies PlaybackGrant;
  });

  const verify = Effect.fn("PlaybackTokenVerifier.verify")(function* (
    token: Redacted.Redacted,
    purposes: ReadonlyArray<TokenPurpose>,
  ) {
    const grant = yield* grantOf(token, purposes);

    if (yield* ended.isEnded(grant.sessionId)) {
      return yield* new PlaybackSessionEnded({ sessionId: grant.sessionId });
    }

    return grant;
  });

  return Service.of({
    verify,
    verifyReport: Effect.fn("PlaybackTokenVerifier.verifyReport")((token: Redacted.Redacted) =>
      grantOf(token, PLAY),
    ),
  });
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
