/**
 * The SDK against a real self-hosted Convex backend:
 *
 *   scripts/dev-stack.sh up && pnpm --filter @movies/sdk test:stack
 *
 * Skipped unless `MOVIES_STACK_TESTS=1`. Shares the owner accounts of the backend's stack suite,
 * so the two suites can run against one stack in either order.
 */
import { targetPosition } from "@movies/contracts/clock";
import type { CommandError } from "@movies/contracts/errors";
import { DeviceId } from "@movies/contracts/ids";
import type { ProfileId, TitleId } from "@movies/contracts/ids";
import { mediaServiceFunctions } from "@movies/contracts/media-service";
import { Milliseconds } from "@movies/contracts/units";
import { Context, Effect, Fiber, Layer, Option, Redacted, Schema, Stream, Struct } from "effect";
import type { Scope } from "effect";
import { describe, expect, it } from "vitest";

import * as Auth from "../auth";
import * as ConvexTransport from "../convex-transport";
import * as DeviceLogin from "../device-login";
import * as Movies from "../movies";
import { MoviesClient } from "../movies-client";
import { hostControlsEnabled, run } from "../room-sync/room-sync";
import { DEFAULT_TUNABLES } from "../room-sync/sync-policy";
import type { CallError } from "../sdk-errors";
import { makeFakePlayer } from "../testing/fake-player";
import { findStack } from "../testing/stack-env";
import * as TokenStorage from "../token-storage";

const stack = findStack();

const url = stack?.convexUrl ?? "";

const PASSWORD = "stack-test-password";

const OWNER_EMAILS = ["owner-a@movies.test", "owner-b@movies.test"] as const;

const id = Math.random().toString(36).slice(2, 8);

type Session = Context.Context<Movies.Services | ConvexTransport.ConvexTransport>;

/** Opens an SDK instance with its own memory token store. */
const open = (connection: "websocket" | "http") =>
  Layer.build(
    Movies.layerWithTransport({ convexUrl: url, mediaUrl: Option.none() }).pipe(
      Layer.provideMerge(
        connection === "websocket"
          ? ConvexTransport.layerWebSocket(url)
          : ConvexTransport.layerHttp(url),
      ),
      Layer.provide(TokenStorage.layerMemory),
    ),
  );

const as =
  (session: Session) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideContext(effect, session);

const clientOf = (session: Session) => Context.get(session, MoviesClient);

const password = (email: string, flow: "signIn" | "signUp", inviteCode?: string) =>
  Auth.Credentials.Password({
    flow,
    email,
    password: Redacted.make(PASSWORD),
    name: Option.none(),
    inviteCode: Option.fromNullishOr(inviteCode),
  });

const signIn = (credentials: Auth.Credentials) =>
  Effect.flatMap(Auth.Auth, (auth) => auth.signIn(credentials));

/** The failure tag an effect ends with, or `succeeded`. */
const outcome = <A, R>(
  effect: Effect.Effect<A, CallError | CommandError | TokenStorage.TokenStorageError, R>,
) =>
  effect.pipe(
    Effect.as("succeeded"),
    Effect.catch((error) => Effect.succeed(Struct.get(error, "_tag"))),
  );

/** Signs in as the stack's owner, creating it on an empty backend. */
const ownerSession = Effect.gen(function* () {
  const session = yield* open("websocket");
  const status = yield* clientOf(session).query("setup.status", {});

  if (!status.hasOwner) {
    yield* as(session)(signIn(password(OWNER_EMAILS[0], "signUp")));

    return session;
  }

  for (const email of OWNER_EMAILS) {
    const result = yield* as(session)(outcome(signIn(password(email, "signIn"))));

    if (result === "succeeded") return session;
  }

  return yield* Effect.die(new Error("The backend has an owner from elsewhere; use a fresh stack"));
});

const scannedItem = (path: string, name: string) => ({
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
          frameRate: 23.976,
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

const UpsertArgs = mediaServiceFunctions["mediaService.upsertScanned"].args;

/** Adds a library with one movie, scanned in by the media service's credential. */
const seedTitle = (owner: Session, ownerProfile: ProfileId) =>
  Effect.gen(function* () {
    const ownerClient = clientOf(owner);
    const name = `Room Movie sdk${id}`;

    const { libraryId } = yield* ownerClient.mutate("libraries.create", {
      name: `SDK ${id}`,
      kind: "movies",
      roots: [`/sdk-stack-${id}`],
    });

    const media = yield* open("http");

    yield* as(media)(
      signIn(Auth.Credentials.ApiKey({ key: Redacted.make(stack?.mediaServiceKey ?? "") })),
    );

    const wire = yield* Schema.encodeUnknownEffect(Schema.toCodecJson(UpsertArgs))(
      yield* Schema.decodeUnknownEffect(UpsertArgs)({
        libraryId,
        items: [scannedItem(`/sdk-stack-${id}/movie.mp4`, name)],
      }),
    ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.JsonObject)), Effect.orDie);

    const transport = Context.get(media, ConvexTransport.ConvexTransport);

    yield* transport.call("mutation", "mediaService:upsertScanned", wire);

    const found = yield* ownerClient.query("titles.search", {
      profileId: ownerProfile,
      query: name,
      limit: 5,
    });

    const [title] = found;

    if (title === undefined) return yield* Effect.die(new Error("The seeded title is not visible"));

    return title.id;
  });

const firstProfile = (session: Session) =>
  Effect.gen(function* () {
    const [profile] = yield* clientOf(session).query("profiles.list", {});

    if (profile === undefined) return yield* Effect.die(new Error("An account has no profile"));

    return profile.id;
  });

const runScoped = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>): Promise<A> =>
  Effect.runPromise(Effect.scoped(effect));

describe.skipIf(stack === undefined)("the SDK against a real stack", () => {
  it(
    "signs in with a password and reads the viewer over both connections",
    () =>
      runScoped(
        Effect.gen(function* () {
          const owner = yield* ownerSession;
          const viewer = yield* clientOf(owner).query("account.viewer", {});

          expect(viewer.user.role).toBe("owner");
          expect(viewer.sessionKind).toBe("password");

          const http = yield* open("http");

          yield* as(http)(signIn(password(viewer.user.email ?? "", "signIn")));
          expect((yield* clientOf(http).query("account.viewer", {})).user.id).toBe(viewer.user.id);
        }),
      ),
    60_000,
  );

  it(
    "refreshes the token on demand and signs out on the server",
    () =>
      runScoped(
        Effect.gen(function* () {
          const owner = yield* ownerSession;
          const auth = Context.get(owner, Auth.Auth);
          const before = yield* auth.accessToken(false);
          // JWTs carry second-resolution timestamps; a refresh in the same second is identical.
          yield* Effect.sleep("1100 millis");
          const after = yield* auth.accessToken(true);

          expect(Option.isSome(after)).toBe(true);
          expect(Option.map(after, Redacted.value)).not.toStrictEqual(
            Option.map(before, Redacted.value),
          );
          expect(yield* outcome(clientOf(owner).query("account.viewer", {}))).toBe("succeeded");

          yield* auth.signOut;
          expect(yield* auth.currentStatus).toBe("signedOut");
          expect(yield* outcome(clientOf(owner).query("account.viewer", {}))).toBe(
            "Unauthenticated",
          );
        }),
      ),
    60_000,
  );

  it(
    "signs in with a scoped API key until the key is revoked",
    () =>
      runScoped(
        Effect.gen(function* () {
          const owner = yield* ownerSession;
          const ownerClient = Context.get(owner, MoviesClient);

          const created = yield* as(owner)(
            ownerClient.action("apiKeys.create", { name: `SDK ${id}`, scopes: ["read"] }),
          );

          const agent = yield* open("http");

          yield* as(agent)(signIn(Auth.Credentials.ApiKey({ key: Redacted.make(created.secret) })));
          const agentClient = Context.get(agent, MoviesClient);
          const viewer = yield* agentClient.query("account.viewer", {});

          expect(viewer).toMatchObject({ sessionKind: "apikey", scopes: ["read"] });
          expect(
            yield* outcome(agentClient.action("apiKeys.create", { name: "x", scopes: ["read"] })),
          ).toBe("Forbidden");

          yield* ownerClient.mutate("apiKeys.revoke", { apiKeyId: created.apiKey.id });
          expect(yield* outcome(agentClient.query("account.viewer", {}))).toBe("Unauthenticated");

          const again = yield* open("http");

          expect(
            yield* as(again)(
              outcome(signIn(Auth.Credentials.ApiKey({ key: Redacted.make(created.secret) }))),
            ),
          ).toBe("Unauthenticated");
        }),
      ),
    60_000,
  );

  it(
    "completes a device sign-in approved from another session",
    () =>
      runScoped(
        Effect.gen(function* () {
          const owner = yield* ownerSession;
          const device = yield* open("websocket");
          const login = yield* as(device)(DeviceLogin.start(`SDK TV ${id}`));
          const waiting = yield* Effect.forkChild(login.complete);

          yield* clientOf(owner).mutate("deviceAuth.approve", {
            userCode: login.userCode,
            scopes: ["read", "play"],
          });

          yield* Fiber.join(waiting);
          const viewer = yield* clientOf(device).query("account.viewer", {});

          expect(viewer).toMatchObject({ sessionKind: "device", scopes: ["read", "play"] });
          expect(yield* Context.get(device, Auth.Auth).currentStatus).toBe("signedIn");
        }),
      ),
    60_000,
  );

  it(
    "keeps a guest on the host's timeline in a real room and rejects guest controls",
    () =>
      runScoped(
        Effect.gen(function* () {
          const owner = yield* ownerSession;
          const ownerClient = Context.get(owner, MoviesClient);
          const ownerProfile = yield* firstProfile(owner);
          const titleId: TitleId = yield* seedTitle(owner, ownerProfile);
          const email = `sdk-guest-${id}@movies.test`;
          const invite = yield* ownerClient.action("invites.create", { email, role: "member" });
          const guest = yield* open("websocket");

          yield* as(guest)(signIn(password(email, "signUp", invite.code)));
          const guestClient = Context.get(guest, MoviesClient);
          const guestProfile = yield* firstProfile(guest);
          const hostDevice = DeviceId.make(`sdk-host-${id}`);
          const guestDevice = DeviceId.make(`sdk-guest-${id}`);

          const room = yield* ownerClient.mutate("rooms.create", {
            profileId: ownerProfile,
            deviceId: hostDevice,
            titleId,
            positionMs: Milliseconds.make(0),
          });

          yield* guestClient.mutate("rooms.join", {
            roomId: room.id,
            profileId: guestProfile,
            deviceId: guestDevice,
          });

          const hostPlayer = yield* makeFakePlayer(0);
          const guestPlayer = yield* makeFakePlayer(0);
          const options = { roomId: room.id, player: hostPlayer, tunables: DEFAULT_TUNABLES };
          const host = yield* as(owner)(run({ ...options, deviceId: hostDevice }));

          yield* as(guest)(run({ ...options, deviceId: guestDevice, player: guestPlayer }));
          expect(hostControlsEnabled(yield* host.current)).toBe(true);

          hostPlayer.userSeek(42_000);
          hostPlayer.userPlay();
          yield* Effect.sleep("3 seconds");

          const committed = yield* guestClient.query("rooms.get", { roomId: room.id });

          expect(committed.clock.status).toBe("playing");
          expect(guestPlayer.isPaused()).toBe(false);
          expect(Math.abs(guestPlayer.positionMs() - hostPlayer.positionMs())).toBeLessThan(250);

          const seen = yield* guestClient
            .subscribe("rooms.get", { roomId: room.id })
            .pipe(Stream.take(1), Stream.runCollect);

          expect(seen.map((r) => r.clock.revision)).toStrictEqual([committed.clock.revision]);

          const live = targetPosition(committed.clock, committed.clock.anchorServerTime);

          expect(
            yield* outcome(
              guestClient.mutate("rooms.pause", {
                roomId: room.id,
                deviceId: guestDevice,
                revision: committed.clock.revision,
                positionMs: live,
              }),
            ),
          ).toBe("Forbidden");

          hostPlayer.userPause();
          yield* Effect.sleep("1500 millis");
          expect(guestPlayer.isPaused()).toBe(true);
          expect(Math.abs(guestPlayer.positionMs() - hostPlayer.positionMs())).toBeLessThan(250);

          yield* ownerClient.mutate("rooms.end", { roomId: room.id, deviceId: hostDevice });
        }),
      ),
    90_000,
  );
});
