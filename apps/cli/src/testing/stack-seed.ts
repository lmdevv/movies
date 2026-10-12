/**
 * Seeds what the CLI cannot do itself in the real-stack suite: the media service scanning a file
 * into a library, and a new member redeeming an invite. Uses the SDK the way the web app and the
 * media service do.
 */
import { mediaServiceFunctions } from "@movies/contracts/media-service";
import { Auth, ConvexTransport, Movies, TokenStorage } from "@movies/sdk/effect";
import { Context, Effect, Layer, Option, Redacted, Schema } from "effect";

const open = (convexUrl: string) =>
  Layer.build(
    Movies.layerWithTransport({ convexUrl, mediaUrl: Option.none() }).pipe(
      Layer.provideMerge(ConvexTransport.layerHttp(convexUrl)),
      Layer.provide(TokenStorage.layerMemory),
    ),
  );

const UpsertArgs = mediaServiceFunctions["mediaService.upsertScanned"].args;

/** A scanned movie as the media service reports it. */
const scannedMovie = (path: string, name: string) => ({
  file: {
    path,
    sizeBytes: 1_000_000,
    mtimeMs: 1_760_000_000_000,
    probe: {
      container: "mp4",
      durationMs: 600_000,
      bitRate: 5_000_000,
      video: [
        {
          index: 0,
          codec: "h264",
          profile: "High",
          width: 1920,
          height: 1080,
          frameRate: 24,
          bitDepth: 8,
          pixelFormat: "yuv420p",
          hdr: "none",
          bitRate: null,
        },
      ],
      audio: [],
      subtitles: [],
    },
    externalSubtitles: [],
    versionName: null,
  },
  title: {
    kind: "movie",
    matchKey: `local:${name.toLowerCase()}`,
    name,
    sortName: null,
    year: 2024,
    overview: null,
    tagline: null,
    genres: [],
    certification: null,
    ageRating: 0,
    runtimeMs: 600_000,
    artwork: { poster: null, backdrop: null, logo: null },
    externalIds: { tmdb: null, imdb: null, tvdb: null },
    matchStatus: "unmatched",
  },
  episode: null,
});

/** Scans one movie named `name` at `path` into `libraryId`, as the media service would. */
export const scanMovie = (
  convexUrl: string,
  mediaServiceKey: string,
  libraryId: string,
  path: string,
  name: string,
): Promise<void> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const media = yield* open(convexUrl);

        yield* Context.get(media, Auth.Auth).signIn(
          Auth.Credentials.ApiKey({ key: Redacted.make(mediaServiceKey) }),
        );

        const args = yield* Schema.decodeUnknownEffect(UpsertArgs)({
          libraryId,
          items: [scannedMovie(path, name)],
        });

        const wire = yield* Schema.encodeEffect(Schema.toCodecJson(UpsertArgs))(args).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.JsonObject)),
        );

        yield* Context.get(media, ConvexTransport.ConvexTransport).call(
          "mutation",
          "mediaService:upsertScanned",
          wire,
        );
      }),
    ),
  );

/** Creates an account: the owner on an empty backend (no invite), or a member from an invite code. */
export const signUp = (
  convexUrl: string,
  email: string,
  password: string,
  inviteCode: string | null,
): Promise<void> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* open(convexUrl);

        yield* Context.get(session, Auth.Auth).signIn(
          Auth.Credentials.Password({
            flow: "signUp",
            email,
            password: Redacted.make(password),
            name: Option.none(),
            inviteCode: Option.fromNullishOr(inviteCode),
          }),
        );
      }),
    ),
  );
