/** Shortcuts for finding and playing titles and reading progress. */
import { commands } from "@movies/contracts/commands";
import { NotFound } from "@movies/contracts/errors";
import { EpisodeId, TitleId } from "@movies/contracts/ids";
import type { ProfileId } from "@movies/contracts/ids";
import { type ClientCapabilities, PlaybackApiError } from "@movies/contracts/media-playback";
import type { TitleCard } from "@movies/contracts/models/catalog";
import { MoviesClient, Playback } from "@movies/sdk/effect";
import { Effect, Option, Result, Schema } from "effect";

import { LaunchError, PlaybackRefused } from "./cli-errors";
import { runAttached } from "./files";
import type { ShortcutCommand } from "./invocation";
import {
  booleanFlag,
  encodeResult,
  positionalText,
  positionFlag,
  requirePositional,
  resultOutcome,
  stringFlag,
  textOutcome,
  usage,
  viewingProfile,
} from "./invocation";
import { formatDuration } from "./render";
import type { Connection } from "./session";
import { connect } from "./session";

/** Lowercase with accents and punctuation folded, for comparing titles. */
const normalize = (text: string): string =>
  text
    .normalize("NFKD")
    .replaceAll(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** What a Convex document ID looks like; such a query is tried as a title ID first. */
const CONVEX_ID = /^[a-z0-9]{32}$/u;

/** The best match for `query`: an exact name, then a name starting with it, then the first result. */
export const bestTitle = (
  query: string,
  results: ReadonlyArray<TitleCard>,
): Option.Option<TitleCard> => {
  const wanted = normalize(query);

  return Option.fromNullishOr(
    results.find((title) => normalize(title.name) === wanted) ??
      results.find((title) => normalize(title.name).startsWith(wanted)) ??
      results[0],
  );
};

/** Finds a title by ID or by searching its name on the profile. */
export const findTitle = Effect.fn("Watch.findTitle")(function* (
  connection: Connection,
  profileId: ProfileId,
  query: string,
) {
  if (CONVEX_ID.test(query)) {
    const byId = yield* connection
      .withSession(
        connection.client.query("titles.get", { profileId, titleId: TitleId.make(query) }),
      )
      .pipe(
        Effect.asSome,
        Effect.catchTags({
          NotFound: () => Effect.succeedNone,
          InvalidArgs: () => Effect.succeedNone,
          Internal: () => Effect.succeedNone,
        }),
      );

    if (Option.isSome(byId)) return byId.value;
  }

  const results = yield* connection.withSession(
    connection.client.query("titles.search", { profileId, query, limit: 20 }),
  );

  const byId = results.find((title) => title.id === query);
  const found = byId === undefined ? bestTitle(query, results) : Option.some(byId);

  if (Option.isNone(found)) return yield* new NotFound({ message: `Nothing matches "${query}"` });

  return found.value;
});

/** What mpv, VLC, and similar desktop players can play: everything, so direct play wins. */
const DESKTOP_PLAYER: ClientCapabilities = {
  containers: ["mp4", "mov", "mkv", "webm", "avi", "ts", "other"],
  videoCodecs: ["h264", "hevc", "av1", "vp9", "vp8", "mpeg4", "mpeg2video", "vc1"].map((codec) => ({
    codec,
    maxBitDepth: 12,
    dynamicRanges: ["sdr", "hdr10", "hlg", "dolby-vision"],
  })),
  audioCodecs: [
    "aac",
    "ac3",
    "eac3",
    "dts",
    "truehd",
    "flac",
    "opus",
    "mp3",
    "vorbis",
    "pcm_s16le",
  ].map((codec) => ({ codec, maxChannels: 8 })),
  maxWidth: 7680,
  maxHeight: 4320,
  hls: true,
  mse: false,
};

const search: ShortcutCommand = {
  path: "search",
  options: { limit: { type: "string" }, "profile-id": { type: "string" } },
  positionals: true,
  run: (invocation) =>
    Effect.gen(function* () {
      const query = yield* requirePositional(invocation, "a search query");
      const limit = Option.map(stringFlag(invocation.tokens, "limit"), Number);

      if (
        Option.isSome(limit) &&
        !(Number.isInteger(limit.value) && limit.value >= 1 && limit.value <= 50)
      ) {
        return yield* usage(invocation, "--limit expects a whole number from 1 to 50");
      }

      const connection = yield* connect(invocation.env, invocation.target, "required");
      const profileId = yield* viewingProfile(invocation, connection.viewingProfileId);

      const results = yield* connection.withSession(
        connection.client.query("titles.search", {
          profileId,
          query,
          ...Option.match(limit, { onNone: () => ({}), onSome: (value) => ({ limit: value }) }),
        }),
      );

      const command = commands["titles.search"];

      return resultOutcome(command, yield* encodeResult("titles.search", command, results));
    }),
};

const play: ShortcutCommand = {
  path: "play",
  options: {
    "episode-id": { type: "string" },
    from: { type: "string" },
    open: { type: "boolean" },
    "profile-id": { type: "string" },
  },
  positionals: true,
  run: (invocation) =>
    Effect.gen(function* () {
      const query = yield* requirePositional(invocation, "a title name or ID");
      const from = yield* positionFlag(invocation, "from");
      const connection = yield* connect(invocation.env, invocation.target, "required");
      const profileId = yield* viewingProfile(invocation, connection.viewingProfileId);
      const title = yield* findTitle(connection, profileId, query);

      const flagEpisode = Option.map(stringFlag(invocation.tokens, "episode-id"), (id) =>
        EpisodeId.make(id),
      );

      const episode =
        title.kind === "movie" || Option.isSome(flagEpisode)
          ? Option.map(flagEpisode, (id) => ({ id, label: id }))
          : yield* Effect.gen(function* () {
              const detail = yield* connection.withSession(
                connection.client.query("titles.get", { profileId, titleId: title.id }),
              );

              if (detail.nextEpisode === null) {
                return yield* new NotFound({
                  message: `${title.name} has no episode to play next; pass --episode-id`,
                });
              }

              const next = detail.nextEpisode;

              return Option.some({
                id: next.id,
                label: `S${String(next.seasonNumber)}E${String(next.episodeNumber)} ${next.name}`,
              });
            });

      // Playback API failures pass through the session wrapper as values, so a refreshed sign-in
      // retries only the Convex calls, then become the CLI's playback error.
      const outcome = yield* connection.withSession(
        Playback.start({
          profileId,
          deviceId: connection.deviceId,
          deviceName: Option.some("movies CLI"),
          titleId: title.id,
          episodeId: Option.map(episode, (chosen) => chosen.id),
          fileId: Option.none(),
          roomId: Option.none(),
          capabilities: DESKTOP_PLAYER,
          startAtMs: from,
          audioStreamIndex: Option.none(),
        }).pipe(
          Effect.provideService(MoviesClient.MoviesClient, connection.client),
          Effect.map(Result.succeed),
          Effect.catchIf(Schema.is(PlaybackApiError), (error) =>
            Effect.succeed(Result.fail(error)),
          ),
        ),
      );

      if (Result.isFailure(outcome)) {
        return yield* new PlaybackRefused({
          error: outcome.failure,
          recovery: Playback.recoveryFor(outcome.failure),
        });
      }

      const playback = outcome.success;

      const json = {
        sessionId: playback.started.sessionId,
        title: title.name,
        titleId: title.id,
        episode: Option.getOrNull(Option.map(episode, (chosen) => chosen.label)),
        mode: playback.stream.mode,
        url: playback.stream.url,
        startSeconds: playback.stream.startSeconds,
        durationSeconds: playback.stream.durationSeconds,
        expiresAt: playback.stream.expiresAt,
      };

      if (booleanFlag(invocation.tokens, "open")) {
        const args = [
          `--start=${String(playback.stream.startSeconds)}`,
          `--force-media-title=${title.name}`,
          playback.stream.url,
        ];

        yield* Effect.tryPromise({
          try: () => runAttached("mpv", args),
          catch: (cause) =>
            new LaunchError({
              program: "mpv",
              message: "Could not start mpv; install it or play the printed URL in another player",
              cause,
            }),
        });
      }

      return textOutcome(
        json,
        [
          `${title.name}${Option.match(episode, { onNone: () => "", onSome: (chosen) => ` ${chosen.label}` })} (${playback.stream.mode}, from ${formatDuration(playback.stream.startSeconds * 1000)})`,
          playback.stream.url,
        ].join("\n"),
      );
    }),
};

const progress: ShortcutCommand = {
  path: "progress",
  options: { "profile-id": { type: "string" } },
  positionals: true,
  run: (invocation) =>
    Effect.gen(function* () {
      const connection = yield* connect(invocation.env, invocation.target, "required");
      const profileId = yield* viewingProfile(invocation, connection.viewingProfileId);
      const query = positionalText(invocation.tokens);

      if (Option.isNone(query)) {
        const history = yield* connection.withSession(
          connection.client.query("history.list", { profileId, limit: 20 }),
        );

        const command = commands["history.list"];

        return resultOutcome(command, yield* encodeResult("history.list", command, history));
      }

      const title = yield* findTitle(connection, profileId, query.value);

      const detail = yield* connection.withSession(
        connection.client.query("titles.get", { profileId, titleId: title.id }),
      );

      const json = {
        titleId: detail.id,
        name: detail.name,
        progress:
          detail.progress === null
            ? null
            : {
                positionMs: detail.progress.positionMs,
                durationMs: detail.progress.durationMs,
                watched: detail.progress.watched,
              },
        nextEpisode:
          detail.nextEpisode === null
            ? null
            : {
                id: detail.nextEpisode.id,
                seasonNumber: detail.nextEpisode.seasonNumber,
                episodeNumber: detail.nextEpisode.episodeNumber,
                name: detail.nextEpisode.name,
              },
      };

      const line =
        detail.progress !== null
          ? `${detail.name}: ${formatDuration(detail.progress.positionMs)} of ${formatDuration(detail.progress.durationMs)}${detail.progress.watched ? " (watched)" : ""}`
          : detail.nextEpisode !== null
            ? `${detail.name}: next S${String(detail.nextEpisode.seasonNumber)}E${String(detail.nextEpisode.episodeNumber)} ${detail.nextEpisode.name}`
            : `${detail.name}: not started`;

      return textOutcome(json, line);
    }),
};

const continueWatching: ShortcutCommand = {
  path: "continue",
  options: { "profile-id": { type: "string" } },
  positionals: false,
  run: (invocation) =>
    Effect.gen(function* () {
      const connection = yield* connect(invocation.env, invocation.target, "required");
      const profileId = yield* viewingProfile(invocation, connection.viewingProfileId);

      const items = yield* connection.withSession(
        connection.client.query("history.continueWatching", { profileId }),
      );

      const command = commands["history.continueWatching"];

      return resultOutcome(
        command,
        yield* encodeResult("history.continueWatching", command, items),
      );
    }),
};

/** The watching shortcuts. */
export const watchCommands: ReadonlyArray<ShortcutCommand> = [
  search,
  play,
  progress,
  continueWatching,
];
