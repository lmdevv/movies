/**
 * Authorization, auth flows, and playback against a real self-hosted Convex backend:
 *
 *   scripts/dev-stack.sh up && pnpm --filter @movies/backend test:stack
 *
 * Skipped unless `MOVIES_STACK_TESTS=1` (the `test:stack` script sets it). On an empty backend the
 * first test races two sign-ups for the owner account; later runs sign in as whichever won.
 */
import type { AnyCommand } from "@movies/contracts/command";
import type { CommandArgs } from "@movies/contracts/commands";
import { commands } from "@movies/contracts/commands";
import type {
  DeviceId,
  JobId,
  LibraryId,
  PersonId,
  PlaybackSessionId,
  ProfileId,
  TitleId,
  UserId,
} from "@movies/contracts/ids";
import type { CatalogFile, WatchStateImport } from "@movies/contracts/models/migration-service";
import { DeviceId as DeviceIdSchema } from "@movies/contracts/ids";
import type { TitleCard } from "@movies/contracts/models/catalog";
import {
  type ScannedEpisode as ScannedEpisodeSchema,
  ScannedItem,
  type ScannedTitle as ScannedTitleSchema,
} from "@movies/contracts/models/scan";
import {
  importPlaybackTokenSecret,
  PLAYBACK_TOKEN_LIFETIME_MS,
  verifyPlaybackToken,
} from "@movies/contracts/playback-token";
import { mediaServiceFunctions } from "@movies/contracts/media-service";
import type { CommandAccess } from "@movies/contracts/scopes";
import { Bytes, EpochMillis, Milliseconds } from "@movies/contracts/units";
import { makeFunctionReference } from "convex/server";
import { Effect, Match, Redacted, Schema } from "effect";
import { beforeAll, describe, expect, it } from "vitest";

import type { Session, SignInParams } from "./harness";
import { anonymous, outcome, run, runId, service, signIn, trySignIn } from "./harness";
import type { PublicFunction } from "./public-functions";
import { publicFunctions, sampleValue, tablesIn } from "./public-functions";
import { findStack, importDocuments, sampleIds } from "./stack-env";

const stack = findStack();

const url = stack?.convexUrl ?? "";

const PASSWORD = "stack-test-password";

const OWNER_RACERS = ["owner-a@movies.test", "owner-b@movies.test"] as const;

const id = runId();

/** Every title name carries this token, so search finds this run's catalog only. */
const TOKEN = `run${id}`;

const decodeItem = Schema.decodeUnknownSync(ScannedItem);

/** Generated arguments are always an object; this checks it and gives Convex its argument type. */
const toArgs = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));

const ms = (value: number): Milliseconds => Milliseconds.make(value);

const device = (name: string): DeviceId => DeviceIdSchema.make(`${name}-${id}`);

const DURATION_MS = 600_000;

type Encoded<Item> = Item extends { readonly Encoded: infer E } ? E : never;

/** Rich fields a rescan adds to a fixture title or episode. */
interface ScanExtras {
  readonly title?: Partial<Encoded<typeof ScannedTitleSchema>>;
  readonly episode?: Partial<Encoded<typeof ScannedEpisodeSchema>>;
}

/** A scanned file as the media service would report it, through the contract's parser. */
const scanned = (
  path: string,
  title: {
    readonly kind: "movie" | "show";
    readonly name: string;
    readonly ageRating: number | null;
  },
  episode: { readonly season: number; readonly episode: number } | null,
  extras: ScanExtras = {},
): ScannedItem =>
  decodeItem({
    file: {
      path,
      sizeBytes: 1_000_000,
      mtimeMs: 1_760_000_000_000,
      probe: {
        container: "mp4",
        durationMs: DURATION_MS,
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
      kind: title.kind,
      matchKey: `local:${title.name.toLowerCase()}`,
      name: title.name,
      sortName: null,
      year: 2024,
      overview: null,
      tagline: null,
      genres: [],
      certification: null,
      ageRating: title.ageRating,
      runtimeMs: DURATION_MS,
      artwork: { poster: null, backdrop: `backdrop-${id}`, logo: null },
      externalIds: { tmdb: null, imdb: null, tvdb: null },
      matchStatus: "unmatched",
      ...extras.title,
    },
    episode:
      episode === null
        ? null
        : {
            seasonNumber: episode.season,
            episodeNumber: episode.episode,
            name: `Episode ${episode.episode}`,
            overview: null,
            airDate: null,
            runtimeMs: DURATION_MS,
            still: null,
            seasonName: null,
            seasonPoster: null,
            ...extras.episode,
          },
  });

const password = (email: string, flow: "signUp" | "signIn", inviteCode?: string): SignInParams => ({
  provider: "password",
  params:
    inviteCode === undefined
      ? { flow, email, password: PASSWORD }
      : { flow, email, password: PASSWORD, inviteCode },
});

interface Fixture {
  readonly race: ReadonlyArray<string> | null;
  readonly owner: Session;
  readonly member: Session;
  readonly memberEmail: string;
  readonly mediaService: Session;
  /** An API key session of the owner's that holds `read` only. */
  readonly readKey: Session;
  readonly memberProfile: ProfileId;
  readonly ownerProfile: ProfileId;
  readonly kidsProfile: ProfileId;
  readonly openLibrary: LibraryId;
  readonly restrictedLibrary: LibraryId;
  readonly titles: {
    readonly allAges: TitleId;
    readonly adult: TitleId;
    readonly unrated: TitleId;
    readonly show: TitleId;
    readonly hidden: TitleId;
  };
}

const setUpOwner = async (): Promise<{
  readonly race: ReadonlyArray<string> | null;
  readonly owner: Session;
}> => {
  const status = await run(anonymous(url), "setup.status", {});

  if (!status.hasOwner) {
    const attempts = OWNER_RACERS.map((email) => signIn(url, password(email, "signUp")));
    const codes = await Promise.all(attempts.map(outcome));
    const settled = await Promise.allSettled(attempts);
    const winner = settled.find((attempt) => attempt.status === "fulfilled");

    if (winner === undefined) throw new Error("Neither first sign-up succeeded");

    return { race: codes, owner: winner.value };
  }

  const sessions = await Promise.all(
    OWNER_RACERS.map((email) => trySignIn(url, password(email, "signIn")).catch(() => null)),
  );

  const owner = sessions.find((session) => session !== null);

  if (owner === undefined) {
    throw new Error(
      "The backend already has an owner from elsewhere; point the suite at a fresh stack",
    );
  }

  return { race: null, owner };
};

const inviteMember = async (owner: Session, email: string): Promise<Session> => {
  const created = await run(owner, "invites.create", { email, role: "member" });

  return signIn(url, password(email, "signUp", created.code));
};

const firstProfile = async (session: Session): Promise<ProfileId> => {
  const [profile] = await run(session, "profiles.list", {});

  if (profile === undefined) throw new Error("A new account has no profile");

  return profile.id;
};

const titleNamed = async (
  session: Session,
  profileId: ProfileId,
  name: string,
): Promise<TitleCard> => {
  const results = await run(session, "titles.search", { profileId, query: name, limit: 50 });
  const found = results.find((title) => title.name === name);

  if (found === undefined) throw new Error(`${name} is not visible to this profile`);

  return found;
};

const setUp = async (): Promise<Fixture> => {
  if (stack === undefined) throw new Error("No stack");
  const { race, owner } = await setUpOwner();
  const memberEmail = `member-${id}@movies.test`;
  const member = await inviteMember(owner, memberEmail);

  const mediaService = await signIn(url, {
    provider: "apikey",
    params: { key: stack.mediaServiceKey },
  });

  const readOnly = await run(owner, "apiKeys.create", { name: `Read ${id}`, scopes: ["read"] });
  const readKey = await signIn(url, { provider: "apikey", params: { key: readOnly.secret } });

  const open = await run(owner, "libraries.create", {
    name: `Open ${id}`,
    kind: "mixed",
    roots: [`/stack-${id}/open`],
  });

  const restricted = await run(owner, "libraries.create", {
    name: `Restricted ${id}`,
    kind: "movies",
    roots: [`/stack-${id}/restricted`],
    access: "restricted",
  });

  await service(mediaService, "mediaService.upsertScanned", {
    libraryId: open.libraryId,
    items: [
      scanned(
        `/stack-${id}/open/all-ages.mp4`,
        { kind: "movie", name: `All Ages ${TOKEN}`, ageRating: 0 },
        null,
      ),
      scanned(
        `/stack-${id}/open/adult.mp4`,
        { kind: "movie", name: `Adult ${TOKEN}`, ageRating: 17 },
        null,
      ),
      scanned(
        `/stack-${id}/open/unrated.mp4`,
        { kind: "movie", name: `Unrated ${TOKEN}`, ageRating: null },
        null,
      ),
      scanned(
        `/stack-${id}/open/show/s01e01.mp4`,
        { kind: "show", name: `Show ${TOKEN}`, ageRating: 7 },
        { season: 1, episode: 1 },
      ),
      scanned(
        `/stack-${id}/open/show/s01e02.mp4`,
        { kind: "show", name: `Show ${TOKEN}`, ageRating: 7 },
        { season: 1, episode: 2 },
      ),
    ],
  });

  await service(mediaService, "mediaService.upsertScanned", {
    libraryId: restricted.libraryId,
    items: [
      scanned(
        `/stack-${id}/restricted/hidden.mp4`,
        { kind: "movie", name: `Hidden ${TOKEN}`, ageRating: 0 },
        null,
      ),
    ],
  });

  const ownerProfile = await firstProfile(owner);
  const memberProfile = await firstProfile(member);

  const kids = await run(member, "profiles.create", {
    name: `Kids ${id}`,
    avatar: "fox",
    kids: true,
  });

  return {
    race,
    owner,
    member,
    memberEmail,
    mediaService,
    readKey,
    memberProfile,
    ownerProfile,
    kidsProfile: kids.id,
    openLibrary: open.libraryId,
    restrictedLibrary: restricted.libraryId,
    titles: {
      allAges: (await titleNamed(owner, ownerProfile, `All Ages ${TOKEN}`)).id,
      adult: (await titleNamed(owner, ownerProfile, `Adult ${TOKEN}`)).id,
      unrated: (await titleNamed(owner, ownerProfile, `Unrated ${TOKEN}`)).id,
      show: (await titleNamed(owner, ownerProfile, `Show ${TOKEN}`)).id,
      hidden: (await titleNamed(owner, ownerProfile, `Hidden ${TOKEN}`)).id,
    },
  };
};

/** A stored migration plan as the media service sends it; the credentials are opaque to Convex. */
const plan = (
  serverId: string,
  users: ReadonlyArray<{ readonly sourceUserId: string; readonly profileId: ProfileId }>,
) => ({
  sourceUrl: "http://jellyfin.test:8096",
  serverId,
  credentials: { version: 1 as const, nonce: "bm9uY2U", ciphertext: "c2VhbGVk" },
  users: users.map((user) => ({ ...user, history: "full" as const })),
  libraries: [],
  pathMappings: [],
});

/** Queues a migration for `serverId` and claims it. */
const claimMigration = async (
  fixture: Fixture,
  owner: UserId,
  serverId: string,
): Promise<{ readonly jobId: JobId; readonly worker: string }> => {
  const { jobId } = await service(fixture.mediaService, "migrationService.start", {
    requestedBy: owner,
    source: "jellyfin",
    serverName: "Jellyfin",
    plan: plan(serverId, [{ sourceUserId: "source-owner", profileId: fixture.ownerProfile }]),
  });

  const worker = `migrator-${serverId}`;

  await service(fixture.mediaService, "mediaService.claimJob", {
    jobId,
    workerId: worker,
    leaseMs: 60_000,
  });

  return { jobId, worker };
};

/** Every catalog file, read page by page like the media service does. */
const catalogFiles = async (session: Session): Promise<ReadonlyArray<CatalogFile>> => {
  const read = async (
    cursor: string | null,
    found: ReadonlyArray<CatalogFile>,
  ): Promise<ReadonlyArray<CatalogFile>> => {
    const page = await service(session, "migrationService.catalog", { cursor, limit: 100 });
    const all = [...found, ...page.items];

    return page.nextCursor === null ? all : read(page.nextCursor, all);
  };

  return read(null, []);
};

const at = (offset: number) => EpochMillis.make(1_760_000_000_000 + offset);

const fileAt = async (fixture: Fixture, path: string): Promise<CatalogFile> => {
  const found = (await catalogFiles(fixture.mediaService)).find((file) => file.path === path);

  if (found === undefined) throw new Error(`${path} is not in the catalog`);

  return found;
};

const progressOf = async (fixture: Fixture, titleId: TitleId, episodeId: string | null) => {
  const page = await service(fixture.mediaService, "migrationService.localProgress", {
    profileId: fixture.ownerProfile,
    limit: 100,
  });

  return page.items.find((row) => row.titleId === titleId && row.episodeId === episodeId);
};

/** A member and the profile they use. */
interface Member {
  readonly session: Session;
  readonly profile: ProfileId;
}

/** A person as the media service reports them, named for this run. */
const creditedPerson = (name: string, tmdb: string | null) => ({
  name: `${name} ${TOKEN}`,
  externalIds: { tmdb: tmdb === null ? null : `${tmdb}${id}`, imdb: null, tvdb: null },
  profile: null,
});

const actor = (name: string, tmdb: string | null, order: number) => ({
  person: creditedPerson(name, tmdb),
  kind: "actor" as const,
  role: `Role of ${name}`,
  order,
});

/** Rescans a fixture movie with genres, studios, scores, a trailer, and provider IDs. */
const rescan = async (
  mediaService: Session,
  library: LibraryId,
  path: string,
  title: { readonly name: string; readonly ageRating: number | null },
  extras: NonNullable<ScanExtras["title"]>,
) => {
  await service(mediaService, "mediaService.upsertScanned", {
    libraryId: library,
    items: [scanned(path, { kind: "movie", ...title }, null, { title: extras })],
  });
};

/** People of this run whose names match `name`. */
const searchPeople = async (
  session: Session,
  profileId: ProfileId,
  name: string,
): Promise<ReadonlyArray<PersonId>> =>
  (await run(session, "people.search", { profileId, query: `${name} ${TOKEN}` })).map(
    (found) => found.id,
  );

/** The person of this run named `name`, as `profileId` sees them. */
const findPerson = async (
  session: Session,
  profileId: ProfileId,
  name: string,
): Promise<PersonId> => {
  const [found] = await searchPeople(session, profileId, name);

  if (found === undefined) throw new Error(`${name} is not visible to this profile`);

  return found;
};

/** The metadata filters of `titles.list`. */
type ListFilters = Pick<
  CommandArgs<"titles.list">,
  "genre" | "yearFrom" | "yearTo" | "studio" | "minRating"
>;

describe.skipIf(stack === undefined)("against a real stack", () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await setUp();
  }, 120_000);

  describe("password accounts", () => {
    it("makes exactly one of two racing first sign-ups the owner", async () => {
      const viewer = await run(fixture.owner, "account.viewer", {});

      expect(viewer.user.role).toBe("owner");
      expect(viewer.sessionKind).toBe("password");
      expect(viewer.scopes).toEqual(
        expect.arrayContaining(["read", "play", "account", "manage", "admin"]),
      );

      if (fixture.race !== null)
        expect([...fixture.race].toSorted()).toStrictEqual(["forbidden", "succeeded"]);
    });

    it("signs in with the right password only", async () => {
      expect(await outcome(signIn(url, password(fixture.memberEmail, "signIn")))).toBe("succeeded");

      const wrong = {
        provider: "password",
        params: { flow: "signIn", email: fixture.memberEmail, password: "nope-nope-nope" },
      } as const;

      expect(await outcome(signIn(url, wrong))).toBe("unauthenticated");
    });

    it("refuses sign-ups without an invite", async () => {
      expect(await outcome(signIn(url, password(`stranger-${id}@movies.test`, "signUp")))).toBe(
        "forbidden",
      );
    });

    it("accepts an invite once and gives the new account the invite's role and a profile", async () => {
      const created = await run(fixture.owner, "invites.create", { role: "member" });

      expect(await run(anonymous(url), "invites.lookup", { code: created.code })).toMatchObject({
        state: "open",
      });
      const guest = await signIn(url, password(`guest-${id}@movies.test`, "signUp", created.code));
      const viewer = await run(guest, "account.viewer", {});

      expect(viewer.user.role).toBe("member");
      expect(viewer.scopes).toStrictEqual(["read", "play", "account"]);
      expect(await run(guest, "profiles.list", {})).toHaveLength(1);
      expect(await run(anonymous(url), "invites.lookup", { code: created.code })).toMatchObject({
        state: "used",
      });
      expect(
        await outcome(signIn(url, password(`again-${id}@movies.test`, "signUp", created.code))),
      ).toBe("conflict");
    });

    it("keeps members out of admin commands", async () => {
      expect(await outcome(run(fixture.member, "users.list", {}))).toBe("forbidden");
      expect(await outcome(run(fixture.member, "libraries.listDetails", {}))).toBe("forbidden");
      expect(await outcome(run(fixture.member, "invites.create", { role: "admin" }))).toBe(
        "forbidden",
      );
    });
  });

  describe("account administration", () => {
    it("strips admin scopes from a demoted admin's keys and ends a disabled account's sessions", async () => {
      const email = `admin-${id}@movies.test`;
      const invite = await run(fixture.owner, "invites.create", { email, role: "admin" });
      const admin = await signIn(url, password(email, "signUp", invite.code));
      const adminId = (await run(admin, "account.viewer", {})).user.id;

      const key = await run(admin, "apiKeys.create", {
        name: `Ops ${id}`,
        scopes: ["read", "admin"],
      });

      const agent = await signIn(url, { provider: "apikey", params: { key: key.secret } });

      expect((await run(agent, "account.viewer", {})).scopes).toStrictEqual(["read", "admin"]);
      await run(fixture.owner, "users.setRole", { userId: adminId, role: "member" });
      expect((await run(agent, "account.viewer", {})).scopes).toStrictEqual(["read"]);
      expect(await outcome(run(agent, "users.list", {}))).toBe("forbidden");

      await run(fixture.owner, "users.disable", { userId: adminId });
      expect(await outcome(run(admin, "account.viewer", {}))).toBe("unauthenticated");
      expect(await outcome(run(agent, "account.viewer", {}))).toBe("unauthenticated");
      expect(await outcome(signIn(url, password(email, "signIn")))).toBe("unauthenticated");
      expect(await trySignIn(url, { provider: "apikey", params: { key: key.secret } })).toBeNull();

      await run(fixture.owner, "users.enable", { userId: adminId });
      expect(await outcome(signIn(url, password(email, "signIn")))).toBe("succeeded");
      const ownerId = (await run(fixture.owner, "account.viewer", {})).user.id;
      expect(await outcome(run(fixture.owner, "users.disable", { userId: ownerId }))).toBe(
        "forbidden",
      );
    });
  });

  describe("API keys", () => {
    it("shows a key once, scopes its sessions, and ends them on revocation", async () => {
      const created = await run(fixture.member, "apiKeys.create", {
        name: `Agent ${id}`,
        scopes: ["read"],
      });

      expect(created.secret.startsWith(created.apiKey.prefix)).toBe(true);
      const listed = await run(fixture.member, "apiKeys.list", {});

      expect(JSON.stringify(listed)).not.toContain(created.secret);

      const agent = await signIn(url, { provider: "apikey", params: { key: created.secret } });
      const viewer = await run(agent, "account.viewer", {});

      expect(viewer.sessionKind).toBe("apikey");
      expect(viewer.scopes).toStrictEqual(["read"]);
      expect(await outcome(run(agent, "titles.home", { profileId: fixture.memberProfile }))).toBe(
        "succeeded",
      );

      expect(
        await outcome(
          run(agent, "myList.add", {
            profileId: fixture.memberProfile,
            titleId: fixture.titles.allAges,
          }),
        ),
      ).toBe("forbidden");

      expect(
        await outcome(run(agent, "apiKeys.create", { name: "escalate", scopes: ["read", "play"] })),
      ).toBe("forbidden");

      await run(fixture.member, "apiKeys.revoke", { apiKeyId: created.apiKey.id });

      expect(await outcome(run(agent, "titles.home", { profileId: fixture.memberProfile }))).toBe(
        "unauthenticated",
      );
      expect(
        await trySignIn(url, { provider: "apikey", params: { key: created.secret } }),
      ).toBeNull();
    });

    it("never grants more than the creating session holds", async () => {
      expect(
        await outcome(
          run(fixture.member, "apiKeys.create", { name: "too much", scopes: ["admin"] }),
        ),
      ).toBe("forbidden");

      expect(
        await trySignIn(url, {
          provider: "apikey",
          params: { key: `mk_unknown_${id}_${"x".repeat(32)}` },
        }),
      ).toBeNull();
    });
  });

  describe("device sign-in", () => {
    it("approves a code once and binds the device session to the chosen scopes", async () => {
      const request = await run(anonymous(url), "deviceAuth.request", { clientName: `TV ${id}` });

      expect(
        await run(anonymous(url), "deviceAuth.status", { deviceCode: request.deviceCode }),
      ).toStrictEqual({ state: "pending" });

      expect(
        await trySignIn(url, { provider: "device", params: { deviceCode: request.deviceCode } }),
      ).toBeNull();

      const lookup = await run(fixture.member, "deviceAuth.lookup", {
        userCode: request.userCode.toLowerCase(),
      });

      expect(lookup.clientName).toBe(`TV ${id}`);
      await run(fixture.member, "deviceAuth.approve", {
        userCode: request.userCode,
        scopes: ["read", "play"],
      });

      expect(
        await run(anonymous(url), "deviceAuth.status", { deviceCode: request.deviceCode }),
      ).toStrictEqual({ state: "approved" });

      const tv = await signIn(url, {
        provider: "device",
        params: { deviceCode: request.deviceCode },
      });

      const viewer = await run(tv, "account.viewer", {});

      expect(viewer.sessionKind).toBe("device");
      expect(viewer.scopes).toStrictEqual(["read", "play"]);
      expect(await outcome(run(tv, "apiKeys.list", {}))).toBe("forbidden");
      expect(
        await trySignIn(url, { provider: "device", params: { deviceCode: request.deviceCode } }),
      ).toBeNull();
      expect(
        await run(anonymous(url), "deviceAuth.status", { deviceCode: request.deviceCode }),
      ).toStrictEqual({ state: "consumed" });

      const sessions = await run(fixture.member, "sessions.list", {});
      const deviceSession = sessions.find((session) => session.id === viewer.sessionId);

      expect(deviceSession).toMatchObject({ kind: "device", label: `TV ${id}`, current: false });
      await run(fixture.member, "sessions.revoke", { sessionId: viewer.sessionId });
      expect(await outcome(run(tv, "account.viewer", {}))).toBe("unauthenticated");
    });

    it("refuses denied codes and codes past their ten minutes", async () => {
      const denied = await run(anonymous(url), "deviceAuth.request", {
        clientName: `Denied ${id}`,
      });

      await run(fixture.member, "deviceAuth.deny", { userCode: denied.userCode });

      expect(
        await trySignIn(url, { provider: "device", params: { deviceCode: denied.deviceCode } }),
      ).toBeNull();
      expect(
        await outcome(
          run(fixture.member, "deviceAuth.approve", {
            userCode: denied.userCode,
            scopes: ["read"],
          }),
        ),
      ).toBe("conflict");

      const viewer = await run(fixture.member, "account.viewer", {});
      const deviceCode = `expired-device-code-${id}`;

      const userCode = `ZZZZ-${id
        .toUpperCase()
        .replaceAll(/[^A-Z]/gu, "B")
        .padEnd(4, "B")
        .slice(0, 4)}`;

      const hash = Buffer.from(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(deviceCode)),
      ).toString("hex");

      importDocuments("deviceCodes", [
        JSON.stringify({
          deviceCodeHash: hash,
          userCode,
          clientName: `Old ${id}`,
          status: "approved",
          expiresAt: Date.now() - 1_000,
          decidedBy: viewer.user.id,
          scopes: ["read"],
        }),
      ]);

      expect(await run(anonymous(url), "deviceAuth.status", { deviceCode })).toStrictEqual({
        state: "expired",
      });
      expect(await trySignIn(url, { provider: "device", params: { deviceCode } })).toBeNull();
    });
  });

  describe("the media service", () => {
    it("signs in with only the media-service scope", async () => {
      const viewer = await run(fixture.mediaService, "account.viewer", {});

      expect(viewer.user.role).toBe("service");
      expect(viewer.scopes).toStrictEqual(["media-service"]);
      expect(await outcome(run(fixture.mediaService, "profiles.list", {}))).toBe("forbidden");
      expect(await outcome(run(fixture.mediaService, "users.list", {}))).toBe("forbidden");
      expect(await outcome(run(fixture.mediaService, "libraries.listDetails", {}))).toBe(
        "forbidden",
      );
    });

    it("is the only caller of media service functions", async () => {
      expect(await outcome(service(fixture.owner, "mediaService.pendingJobs", {}))).toBe(
        "forbidden",
      );
      expect(await outcome(service(fixture.member, "mediaService.libraries", {}))).toBe(
        "forbidden",
      );
      expect(await outcome(service(anonymous(url), "mediaService.libraries", {}))).toBe(
        "unauthenticated",
      );
    });

    it("claims, renews, and completes a scan job under a lease", async () => {
      const { jobId } = await run(fixture.owner, "libraries.scan", {
        libraryId: fixture.openLibrary,
        mode: "full",
      });

      const pending = await service(fixture.mediaService, "mediaService.pendingJobs", {});

      expect(pending.map((job) => job.id)).toContain(jobId);

      const claim = await service(fixture.mediaService, "mediaService.claimJob", {
        jobId,
        workerId: `worker-${id}`,
        leaseMs: 60_000,
      });

      expect(claim?.library?.roots).toStrictEqual([`/stack-${id}/open`]);
      expect(
        await service(fixture.mediaService, "mediaService.claimJob", {
          jobId,
          workerId: "other",
          leaseMs: 60_000,
        }),
      ).toBeNull();

      expect(
        await outcome(
          service(fixture.mediaService, "mediaService.renewLease", {
            jobId,
            workerId: "other",
            leaseMs: 60_000,
          }),
        ),
      ).toBe("conflict");

      const renewed = await service(fixture.mediaService, "mediaService.renewLease", {
        jobId,
        workerId: `worker-${id}`,
        leaseMs: 60_000,
        progress: { done: 3, total: 5, message: null },
      });

      expect(renewed.cancelled).toBe(false);
      await service(fixture.mediaService, "mediaService.completeJob", {
        jobId,
        workerId: `worker-${id}`,
      });
      expect(await run(fixture.owner, "jobs.get", { jobId })).toMatchObject({
        status: "succeeded",
        progress: { done: 3 },
      });
    });

    it("adds migrated libraries only for absolute folders nobody else owns", async () => {
      const owner = (await run(fixture.owner, "account.viewer", {})).user.id;
      const { jobId, worker } = await claimMigration(fixture, owner, `server-libraries-${id}`);

      const ensure = (roots: ReadonlyArray<string>) =>
        service(fixture.mediaService, "migrationService.ensureLibrary", {
          jobId,
          workerId: worker,
          name: "Imported",
          kind: "movies",
          roots,
        });

      expect(await outcome(ensure([`/stack-${id}/x/../open`]))).toBe("invalid_args");
      expect(await ensure([`/stack-${id}/open/`])).toStrictEqual({
        libraryIds: [fixture.openLibrary],
        created: false,
      });
      expect(await ensure([`/stack-${id}/open/nested`])).toStrictEqual({
        libraryIds: [fixture.openLibrary],
        created: false,
      });
      expect((await ensure([`/stack-${id}/imported`])).created).toBe(true);
      expect((await ensure([`/stack-${id}/imported`])).created).toBe(false);

      expect(
        await outcome(
          service(fixture.mediaService, "migrationService.start", {
            requestedBy: (await run(fixture.member, "account.viewer", {})).user.id,
            source: "plex",
            serverName: "Plex",
            plan: plan(`server-member-${id}`, []),
          }),
        ),
      ).toBe("forbidden");

      await service(fixture.mediaService, "mediaService.completeJob", { jobId, workerId: worker });
    });

    it("refuses files outside the library's folders", async () => {
      expect(
        await outcome(
          service(fixture.mediaService, "mediaService.upsertScanned", {
            libraryId: fixture.openLibrary,
            items: [
              scanned("/etc/passwd.mp4", { kind: "movie", name: "Escape", ageRating: 0 }, null),
            ],
          }),
        ),
      ).toBe("invalid_args");

      const climb = `/stack-${id}/open/../../etc/x.mp4`;

      expect(
        await outcome(
          service(fixture.mediaService, "mediaService.upsertScanned", {
            libraryId: fixture.openLibrary,
            items: [scanned(climb, { kind: "movie", name: "Climb", ageRating: 0 }, null)],
          }),
        ),
      ).toBe("invalid_args");
    });
  });

  describe("migration imports", () => {
    it("lists files with their titles and episodes for matching", async () => {
      const episode = await fileAt(fixture, `/stack-${id}/open/show/s01e02.mp4`);

      expect(episode).toMatchObject({
        titleId: fixture.titles.show,
        kind: "show",
        seasonNumber: 1,
        episodeNumber: 2,
        missing: false,
      });
      expect(episode.episodeId).not.toBeNull();
    });

    it("imports watch state once and keeps newer [movies] progress", async () => {
      const owner = (await run(fixture.owner, "account.viewer", {})).user.id;
      const { jobId, worker } = await claimMigration(fixture, owner, `server-watch-${id}`);
      const movie = await fileAt(fixture, `/stack-${id}/open/unrated.mp4`);
      const episode = await fileAt(fixture, `/stack-${id}/open/show/s01e01.mp4`);

      const resume = {
        profileId: fixture.ownerProfile,
        titleId: movie.titleId,
        episodeId: null,
        fileId: movie.fileId,
        watched: false,
        positionMs: ms(120_000),
        playCount: 0,
        lastPlayedAt: at(5_000),
        favorite: true,
      };

      const items = [
        resume,
        {
          profileId: fixture.ownerProfile,
          titleId: episode.titleId,
          episodeId: episode.episodeId,
          fileId: episode.fileId,
          watched: true,
          positionMs: ms(0),
          playCount: 3,
          lastPlayedAt: at(4_000),
          favorite: false,
        },
        {
          profileId: fixture.ownerProfile,
          titleId: episode.titleId,
          episodeId: null,
          fileId: null,
          watched: false,
          positionMs: ms(0),
          playCount: 0,
          lastPlayedAt: null,
          favorite: true,
        },
      ];

      const importBatch = (batch: ReadonlyArray<WatchStateImport>) =>
        service(fixture.mediaService, "migrationService.importWatchState", {
          jobId,
          workerId: worker,
          items: batch,
        });

      expect(await importBatch(items)).toStrictEqual({
        watched: 1,
        inProgress: 1,
        playCounts: 1,
        favorites: 2,
        keptLocal: 0,
      });
      expect(await importBatch(items)).toStrictEqual({
        watched: 0,
        inProgress: 0,
        playCounts: 0,
        favorites: 0,
        keptLocal: 0,
      });

      const older = { ...resume, positionMs: ms(30_000), lastPlayedAt: at(1_000) };

      expect((await importBatch([older])).keptLocal).toBe(1);
      expect((await progressOf(fixture, movie.titleId, null))?.positionMs).toBe(120_000);
      expect(await progressOf(fixture, episode.titleId, episode.episodeId)).toMatchObject({
        watched: true,
      });

      const list = await run(fixture.owner, "myList.list", { profileId: fixture.ownerProfile });
      const listed = list.map((title) => title.id);

      expect(listed.filter((titleId) => titleId === movie.titleId)).toHaveLength(1);
      expect(listed).toContain(episode.titleId);

      await service(fixture.mediaService, "mediaService.completeJob", { jobId, workerId: worker });
    });

    it("imports collections and overrides idempotently", async () => {
      const owner = (await run(fixture.owner, "account.viewer", {})).user.id;
      const { jobId, worker } = await claimMigration(fixture, owner, `server-sets-${id}`);
      const lease = { jobId, workerId: worker };

      const collection = {
        sourceKey: `jellyfin:${id}:boxset`,
        name: `Box ${TOKEN}`,
        sortName: null,
        titleIds: [fixture.titles.adult, fixture.titles.allAges, fixture.titles.adult],
      };

      expect(
        await service(fixture.mediaService, "migrationService.importCollections", {
          ...lease,
          items: [collection],
        }),
      ).toStrictEqual({ imported: 1 });
      expect(
        await service(fixture.mediaService, "migrationService.importCollections", {
          ...lease,
          items: [collection],
        }),
      ).toStrictEqual({ imported: 0 });

      const forOwner = await run(fixture.owner, "collections.list", {
        profileId: fixture.ownerProfile,
      });

      const box = forOwner.find((entry) => entry.name === `Box ${TOKEN}`);

      expect(box?.titles.map((title) => title.id)).toStrictEqual([
        fixture.titles.adult,
        fixture.titles.allAges,
      ]);

      const forKids = await run(fixture.member, "collections.list", {
        profileId: fixture.kidsProfile,
      });

      expect(
        forKids.find((entry) => entry.name === `Box ${TOKEN}`)?.titles.map((title) => title.id),
      ).toStrictEqual([fixture.titles.allAges]);

      const override = {
        titleId: fixture.titles.allAges,
        overrides: { sortName: `Aaa ${TOKEN}` },
      };

      expect(
        await service(fixture.mediaService, "migrationService.importOverrides", {
          ...lease,
          items: [override],
        }),
      ).toStrictEqual({ imported: 1 });
      expect(
        await service(fixture.mediaService, "migrationService.importOverrides", {
          ...lease,
          items: [{ ...override, overrides: { sortName: "Zzz" } }],
        }),
      ).toStrictEqual({ imported: 0 });

      await service(fixture.mediaService, "mediaService.completeJob", lease);
    });

    it("reports checkpoints, runs one migration per server, and stops cancelled jobs", async () => {
      const owner = (await run(fixture.owner, "account.viewer", {})).user.id;
      const serverId = `server-status-${id}`;
      const { jobId, worker } = await claimMigration(fixture, owner, serverId);

      const again = await service(fixture.mediaService, "migrationService.start", {
        requestedBy: owner,
        source: "jellyfin",
        serverName: "Jellyfin",
        plan: plan(serverId, []),
      });

      expect(again.jobId).toBe(jobId);

      const state = await service(fixture.mediaService, "migrationService.state", {
        jobId,
        workerId: worker,
      });

      expect(state.checkpoint).toStrictEqual({ phase: "libraries", unit: 0, cursor: 0 });
      expect(
        await outcome(
          service(fixture.mediaService, "migrationService.state", { jobId, workerId: "other" }),
        ),
      ).toBe("conflict");

      const imported = { ...state.imported, watched: 4 };

      expect(
        await service(fixture.mediaService, "migrationService.saveCheckpoint", {
          jobId,
          workerId: worker,
          checkpoint: { phase: "watchState", unit: 1, cursor: 100 },
          imported,
          progress: { done: 100, total: 300, message: "Importing watch history" },
        }),
      ).toStrictEqual({ cancelled: false });

      const runs = await run(fixture.owner, "migration.status", {});
      const current = runs.find((entry) => entry.job.id === jobId);

      expect(current).toMatchObject({
        phase: "watchState",
        imported: { watched: 4 },
        job: { status: "running", progress: { done: 100, total: 300 } },
      });

      await run(fixture.owner, "jobs.cancel", { jobId });
      expect(
        await service(fixture.mediaService, "migrationService.saveCheckpoint", {
          jobId,
          workerId: worker,
          checkpoint: { phase: "watchState", unit: 1, cursor: 200 },
          imported,
          progress: { done: 200, total: 300, message: null },
        }),
      ).toStrictEqual({ cancelled: true });
    });
  });

  describe("profiles", () => {
    it("keeps profiles to their account", async () => {
      expect(
        await outcome(run(fixture.owner, "titles.home", { profileId: fixture.memberProfile })),
      ).toBe("not_found");
    });

    it("locks a PIN profile on other sessions until the PIN is entered", async () => {
      const profile = await run(fixture.member, "profiles.create", {
        name: `Private ${id}`,
        avatar: "owl",
        kids: false,
      });

      await run(fixture.member, "profiles.setPin", { profileId: profile.id, pin: "4821" });
      expect(await outcome(run(fixture.member, "titles.home", { profileId: profile.id }))).toBe(
        "succeeded",
      );

      const other = await signIn(url, password(fixture.memberEmail, "signIn"));

      const listed = (await run(other, "profiles.list", {})).find(
        (candidate) => candidate.id === profile.id,
      );

      expect(listed).toMatchObject({ hasPin: true, locked: true });
      expect(await outcome(run(other, "titles.home", { profileId: profile.id }))).toBe("forbidden");
      expect(
        await outcome(run(other, "profiles.setPin", { profileId: profile.id, pin: null })),
      ).toBe("forbidden");
      expect(
        await run(other, "profiles.unlock", { profileId: profile.id, pin: "0000" }),
      ).toStrictEqual({ status: "wrong_pin", attemptsLeft: 4 });
      expect(
        await run(other, "profiles.unlock", { profileId: profile.id, pin: "4821" }),
      ).toStrictEqual({ status: "unlocked" });
      expect(await outcome(run(other, "titles.home", { profileId: profile.id }))).toBe("succeeded");
      await run(other, "profiles.lock", { profileId: profile.id });
      expect(await outcome(run(other, "titles.home", { profileId: profile.id }))).toBe("forbidden");
    });

    it("keeps a kids profile from lifting its limits once every adult profile has a PIN", async () => {
      const email = `parent-${id}@movies.test`;
      const parent = await inviteMember(fixture.owner, email);
      const adult = await firstProfile(parent);

      const kids = await run(parent, "profiles.create", {
        name: `Little ${id}`,
        avatar: "fox",
        kids: true,
      });

      // Without a PIN on the adult profile, anyone could pick it, so nothing is withheld.
      expect((await run(parent, "account.viewer", {})).scopes).toContain("account");
      await run(parent, "profiles.setPin", { profileId: adult, pin: "2468" });

      // The session that set the PIN stays unlocked; a new browser session starts locked.
      expect((await run(parent, "account.viewer", {})).scopes).toContain("account");
      const shared = await signIn(url, password(email, "signIn"));

      expect((await run(shared, "account.viewer", {})).scopes).toStrictEqual(["read", "play"]);
      expect(
        await outcome(
          run(shared, "profiles.update", { profileId: kids.id, kids: false, maxAgeRating: null }),
        ),
      ).toBe("forbidden");
      expect(
        await outcome(
          run(shared, "profiles.create", { name: `Open ${id}`, avatar: "owl", kids: false }),
        ),
      ).toBe("forbidden");
      expect(
        await outcome(run(shared, "apiKeys.create", { name: `Key ${id}`, scopes: ["read"] })),
      ).toBe("forbidden");
      expect(await outcome(run(shared, "titles.home", { profileId: kids.id }))).toBe("succeeded");

      await run(shared, "profiles.unlock", { profileId: adult, pin: "2468" });
      expect((await run(shared, "account.viewer", {})).scopes).toContain("account");
      await run(shared, "profiles.lock", { profileId: adult });
      expect((await run(shared, "account.viewer", {})).scopes).not.toContain("account");
    });

    it("hides titles above a kids profile's age, and unrated ones, without saying so", async () => {
      const seen = await run(fixture.member, "titles.search", {
        profileId: fixture.kidsProfile,
        query: TOKEN,
        limit: 50,
      });

      expect(seen.map((title) => title.name).toSorted()).toStrictEqual([
        `All Ages ${TOKEN}`,
        `Show ${TOKEN}`,
      ]);
      expect(
        await outcome(
          run(fixture.member, "titles.get", {
            profileId: fixture.kidsProfile,
            titleId: fixture.titles.adult,
          }),
        ),
      ).toBe("not_found");

      const adultSeen = await run(fixture.member, "titles.search", {
        profileId: fixture.memberProfile,
        query: TOKEN,
        limit: 50,
      });

      expect(adultSeen.map((title) => title.name)).toEqual(
        expect.arrayContaining([`Adult ${TOKEN}`, `Unrated ${TOKEN}`]),
      );
    });
  });

  describe("library access", () => {
    it("shows restricted libraries to members only once granted", async () => {
      const titleArgs = { profileId: fixture.memberProfile, titleId: fixture.titles.hidden };

      expect(await outcome(run(fixture.member, "titles.get", titleArgs))).toBe("not_found");
      await run(fixture.owner, "users.setLibraryAccess", {
        userId: (await run(fixture.member, "account.viewer", {})).user.id,
        libraryIds: [fixture.restrictedLibrary],
      });
      expect(await outcome(run(fixture.member, "titles.get", titleArgs))).toBe("succeeded");
      expect(
        (await run(fixture.member, "libraries.list", {})).map((library) => library.id),
      ).toContain(fixture.restrictedLibrary);
    });
  });

  describe("playback", () => {
    it("signs a playback token in Convex that the contracts verifier accepts", async () => {
      const started = await run(fixture.member, "playback.createSession", {
        profileId: fixture.memberProfile,
        deviceId: device("laptop"),
        titleId: fixture.titles.allAges,
      });

      expect(started.tokenExpiresAt - Date.now()).toBeGreaterThan(
        PLAYBACK_TOKEN_LIFETIME_MS - 60_000,
      );
      const secret = Redacted.make(stack?.playbackTokenSecret ?? "");

      const payload = await Effect.runPromise(
        Effect.flatMap(importPlaybackTokenSecret(secret), (key) =>
          verifyPlaybackToken(key, started.token),
        ),
      );

      expect(payload).toMatchObject({
        aud: "media",
        pid: fixture.memberProfile,
        fid: started.file.id,
        sid: started.sessionId,
      });
      expect(payload.exp - payload.iat).toBe(PLAYBACK_TOKEN_LIFETIME_MS);

      const resolved = await service(fixture.mediaService, "mediaService.resolveFile", {
        fileId: started.file.id,
      });

      expect(resolved.path).toBe(`/stack-${id}/open/all-ages.mp4`);
      expect(resolved.roots).toStrictEqual([`/stack-${id}/open`]);
    });

    it("ends a session's playback when it signs out", async () => {
      const laptop = await signIn(url, password(fixture.memberEmail, "signIn"));

      const started = await run(laptop, "playback.createSession", {
        profileId: fixture.memberProfile,
        deviceId: device("signout"),
        titleId: fixture.titles.allAges,
      });

      await laptop.client.action(makeFunctionReference<"action">("auth:signOut"), {});

      expect(
        await service(fixture.mediaService, "mediaService.sessionStatus", {
          sessionId: started.sessionId,
        }),
      ).toMatchObject({ status: "ended" });
      expect(await outcome(run(laptop, "account.viewer", {}))).toBe("unauthenticated");
    });

    it("keeps an account to eight playing devices, ending the quietest", async () => {
      // Earlier tests may leave this account playing somewhere; start from none.
      await Promise.all(
        (await run(fixture.member, "playback.active", {})).map((session) =>
          run(fixture.member, "playback.endSession", { sessionId: session.id, positionMs: ms(0) }),
        ),
      );

      const devices = Array.from({ length: 9 }, (_, index) => device(`wall-${index}`));

      // One after another, so the first device is the quietest.
      const started = await devices.reduce<
        Promise<ReadonlyArray<{ sessionId: PlaybackSessionId }>>
      >(
        async (earlier, deviceId) => [
          ...(await earlier),
          await run(fixture.member, "playback.createSession", {
            profileId: fixture.memberProfile,
            deviceId,
            titleId: fixture.titles.allAges,
          }),
        ],
        Promise.resolve([]),
      );

      const statuses = await Promise.all(
        started.map(({ sessionId }) =>
          service(fixture.mediaService, "mediaService.sessionStatus", { sessionId }),
        ),
      );

      expect(statuses.map((status) => status.status)).toStrictEqual([
        "ended",
        ...Array.from({ length: 8 }, () => "active"),
      ]);

      await Promise.all(
        started.map(({ sessionId }) =>
          run(fixture.member, "playback.endSession", { sessionId, positionMs: ms(0) }),
        ),
      );
    });

    it("reports every session a sign-out ended, even past a page's limit", async () => {
      const tablet = await signIn(url, password(fixture.memberEmail, "signIn"));
      const before = Date.now() - 1;

      const started = await Promise.all(
        ["a", "b", "c"].map((name) =>
          run(tablet, "playback.createSession", {
            profileId: fixture.memberProfile,
            deviceId: device(`tablet-${name}`),
            titleId: fixture.titles.allAges,
          }),
        ),
      );

      await tablet.client.action(makeFunctionReference<"action">("auth:signOut"), {});

      const reported = await service(fixture.mediaService, "mediaService.endedSessions", {
        after: EpochMillis.make(before),
        limit: 2,
      });

      expect(reported.map((session) => session.sessionId)).toStrictEqual(
        expect.arrayContaining(started.map((session) => session.sessionId)),
      );
    });

    it("stops renewing a token once the profile may no longer see the title", async () => {
      await run(fixture.owner, "users.setLibraryAccess", {
        userId: (await run(fixture.member, "account.viewer", {})).user.id,
        libraryIds: [fixture.restrictedLibrary],
      });

      const started = await run(fixture.member, "playback.createSession", {
        profileId: fixture.memberProfile,
        deviceId: device("renew"),
        titleId: fixture.titles.hidden,
      });

      expect(
        await outcome(run(fixture.member, "playback.renewToken", { sessionId: started.sessionId })),
      ).toBe("succeeded");
      await run(fixture.owner, "users.setLibraryAccess", {
        userId: (await run(fixture.member, "account.viewer", {})).user.id,
        libraryIds: [],
      });
      expect(
        await outcome(run(fixture.member, "playback.renewToken", { sessionId: started.sessionId })),
      ).toBe("not_found");
      await run(fixture.owner, "users.setLibraryAccess", {
        userId: (await run(fixture.member, "account.viewer", {})).user.id,
        libraryIds: [fixture.restrictedLibrary],
      });
    });

    it("keeps an older session from overwriting a newer one and marks watched at 90%", async () => {
      const base = { profileId: fixture.memberProfile, titleId: fixture.titles.unrated } as const;

      const older = await run(fixture.member, "playback.createSession", {
        ...base,
        deviceId: device("phone"),
      });

      const newer = await run(fixture.member, "playback.createSession", {
        ...base,
        deviceId: device("tv"),
      });

      expect(
        await run(fixture.member, "playback.reportProgress", {
          sessionId: newer.sessionId,
          positionMs: ms(120_000),
          event: "tick",
        }),
      ).toStrictEqual({ applied: true, watched: false });
      expect(
        await run(fixture.member, "playback.reportProgress", {
          sessionId: older.sessionId,
          positionMs: ms(10_000),
          event: "tick",
        }),
      ).toStrictEqual({ applied: false, watched: false });

      const detail = await run(fixture.member, "titles.get", base);

      expect(detail.progress?.positionMs).toBe(120_000);

      const resume = await run(fixture.member, "history.continueWatching", {
        profileId: fixture.memberProfile,
      });

      expect(resume.map((item) => item.title.id)).toContain(fixture.titles.unrated);
      expect(
        await run(fixture.member, "playback.reportProgress", {
          sessionId: newer.sessionId,
          positionMs: ms(DURATION_MS * 0.91),
          event: "tick",
        }),
      ).toStrictEqual({ applied: true, watched: true });

      await run(fixture.member, "playback.endSession", {
        sessionId: newer.sessionId,
        positionMs: ms(DURATION_MS * 0.91),
      });

      const ended = await service(fixture.mediaService, "mediaService.endedSessions", {
        after: EpochMillis.make(Date.now() - 60_000),
      });

      expect(ended.map((session) => session.sessionId)).toContain(newer.sessionId);
    });

    it("offers the next episode after a finished one", async () => {
      const show = await run(fixture.member, "titles.get", {
        profileId: fixture.memberProfile,
        titleId: fixture.titles.show,
      });

      const first = show.nextEpisode;

      expect(first?.episodeNumber).toBe(1);

      if (first === null) return;

      const started = await run(fixture.member, "playback.createSession", {
        profileId: fixture.memberProfile,
        titleId: fixture.titles.show,
        episodeId: first.id,
        deviceId: device("tablet"),
      });

      await run(fixture.member, "playback.reportProgress", {
        sessionId: started.sessionId,
        positionMs: ms(DURATION_MS),
        event: "ended",
      });

      const next = await run(fixture.member, "playback.nextEpisode", {
        profileId: fixture.memberProfile,
        episodeId: first.id,
      });

      expect(next?.episodeNumber).toBe(2);

      const resume = await run(fixture.member, "history.continueWatching", {
        profileId: fixture.memberProfile,
      });

      expect(resume.find((item) => item.title.id === fixture.titles.show)).toMatchObject({
        reason: "next",
        episode: { episodeNumber: 2 },
      });

      const second = {
        profileId: fixture.memberProfile,
        titleId: fixture.titles.show,
        episodeId: next?.id,
      };

      if (second.episodeId === undefined) return;
      await run(fixture.member, "history.markWatched", { ...second, episodeId: second.episodeId });
      expect((await run(fixture.member, "titles.get", second)).nextEpisode).toBeNull();
      await run(fixture.member, "history.markUnwatched", {
        ...second,
        episodeId: second.episodeId,
      });
      expect((await run(fixture.member, "titles.get", second)).nextEpisode?.episodeNumber).toBe(2);
    });
  });

  describe("watch rooms", () => {
    it("lets only the host's device control the clock, at the current revision", async () => {
      const hostDevice = device("host");
      const guestDevice = device("guest");

      const room = await run(fixture.owner, "rooms.create", {
        profileId: fixture.ownerProfile,
        deviceId: hostDevice,
        titleId: fixture.titles.allAges,
        positionMs: ms(0),
      });

      expect(room.clock).toMatchObject({ status: "paused", revision: 0 });

      const joined = await run(fixture.member, "rooms.join", {
        roomId: room.id,
        profileId: fixture.memberProfile,
        deviceId: guestDevice,
      });

      expect(joined.members.map((member) => member.role).toSorted()).toStrictEqual([
        "guest",
        "host",
      ]);

      const guestControl = {
        roomId: room.id,
        deviceId: guestDevice,
        revision: 0,
        positionMs: ms(5_000),
      };

      expect(await outcome(run(fixture.member, "rooms.play", guestControl))).toBe("forbidden");
      expect(
        await outcome(
          run(fixture.owner, "rooms.play", { ...guestControl, deviceId: device("other") }),
        ),
      ).toBe("forbidden");

      const playing = await run(fixture.owner, "rooms.play", {
        roomId: room.id,
        deviceId: hostDevice,
        revision: 0,
        positionMs: ms(5_000),
      });

      expect(playing).toMatchObject({ status: "playing", revision: 1, positionAtAnchorMs: 5_000 });
      expect(
        await outcome(
          run(fixture.owner, "rooms.pause", {
            roomId: room.id,
            deviceId: hostDevice,
            revision: 0,
            positionMs: ms(6_000),
          }),
        ),
      ).toBe("stale_revision");

      const guestStream = await run(fixture.member, "playback.createSession", {
        profileId: fixture.memberProfile,
        deviceId: guestDevice,
        titleId: fixture.titles.allAges,
        roomId: room.id,
      });

      expect(guestStream.file.id).toBe(room.fileId);
      await run(fixture.member, "rooms.heartbeat", { roomId: room.id, deviceId: guestDevice });
      await run(fixture.member, "rooms.leave", { roomId: room.id, deviceId: guestDevice });
      expect((await run(fixture.owner, "rooms.get", { roomId: room.id })).clock.status).toBe(
        "playing",
      );
      expect(
        await outcome(run(fixture.member, "rooms.end", { roomId: room.id, deviceId: guestDevice })),
      ).toBe("forbidden");
      await run(fixture.owner, "rooms.end", { roomId: room.id, deviceId: hostDevice });
      expect((await run(fixture.owner, "rooms.get", { roomId: room.id })).clock.status).toBe(
        "ended",
      );
      expect(
        await outcome(
          run(fixture.member, "rooms.join", {
            roomId: room.id,
            profileId: fixture.memberProfile,
            deviceId: guestDevice,
          }),
        ),
      ).toBe("conflict");
    });

    it("keeps kids profiles out of rooms for titles they cannot see", async () => {
      const room = await run(fixture.owner, "rooms.create", {
        profileId: fixture.ownerProfile,
        deviceId: device("host2"),
        titleId: fixture.titles.adult,
        positionMs: ms(0),
      });

      expect(
        await outcome(
          run(fixture.member, "rooms.join", {
            roomId: room.id,
            profileId: fixture.kidsProfile,
            deviceId: device("kid"),
          }),
        ),
      ).toBe("not_found");
    });
  });

  describe("rich metadata", () => {
    let stranger: Member;

    beforeAll(async () => {
      const open = `/stack-${id}/open`;
      const session = await inviteMember(fixture.owner, `stranger-${id}@movies.test`);

      stranger = { session, profile: await firstProfile(session) };

      await rescan(
        fixture.mediaService,
        fixture.openLibrary,
        `${open}/all-ages.mp4`,
        { name: `All Ages ${TOKEN}`, ageRating: 0 },
        {
          year: 1999,
          genres: ["Drama", `Genre ${id}`],
          externalIds: { tmdb: `all${id}`, imdb: null, tvdb: null },
          studios: [`Studio ${id}`],
          countries: ["Canada"],
          tags: [`tag-${id}`],
          releaseDate: "1999-03-31",
          originalLanguage: "en",
          ratings: {
            tmdb: { value: 7.1, votes: 900 },
            imdb: { value: 8.7, votes: 2_000_000 },
            rottenTomatoes: 88,
            metacritic: 73,
          },
          trailer: { site: "youtube", key: "dQw4w9WgXcQ", name: "Trailer" },
          recommendations: [`adult${id}`, `hidden${id}`],
        },
      );

      await rescan(
        fixture.mediaService,
        fixture.openLibrary,
        `${open}/adult.mp4`,
        { name: `Adult ${TOKEN}`, ageRating: 17 },
        {
          year: 2012,
          genres: [`Genre ${id}`],
          externalIds: { tmdb: `adult${id}`, imdb: null, tvdb: null },
          ratings: {
            tmdb: { value: 5.5, votes: 10 },
            imdb: null,
            rottenTomatoes: null,
            metacritic: null,
          },
          trailer: null,
        },
      );

      await rescan(
        fixture.mediaService,
        fixture.restrictedLibrary,
        `/stack-${id}/restricted/hidden.mp4`,
        { name: `Hidden ${TOKEN}`, ageRating: 0 },
        { genres: [`Genre ${id}`], externalIds: { tmdb: `hidden${id}`, imdb: null, tvdb: null } },
      );

      const credits = [
        actor("Lead", "1", 0),
        actor("Second", null, 1),
        { person: creditedPerson("Maker", "2"), kind: "director" as const, role: null, order: 2 },
      ];

      await Promise.all(
        [fixture.titles.allAges, fixture.titles.adult, fixture.titles.hidden].map((titleId) =>
          service(fixture.mediaService, "mediaService.applyCredits", {
            titleId,
            episodeId: null,
            credits: titleId === fixture.titles.allAges ? credits : [actor("Lead", "1", 0)],
            hash: `${titleId}-v1`,
          }),
        ),
      );

      // Someone credited only on the adult title.
      await service(fixture.mediaService, "mediaService.applyCredits", {
        titleId: fixture.titles.adult,
        episodeId: null,
        credits: [actor("Lead", "1", 0), actor("Grown", "3", 1)],
        hash: "adult-v2",
      });

      const collection = {
        sourceKey: `tmdb:collection${id}`,
        name: `Saga ${TOKEN}`,
        overview: "Every film of the saga.",
        poster: null,
        backdrop: null,
      };

      await service(fixture.mediaService, "mediaService.applyCollection", {
        titleId: fixture.titles.adult,
        collection,
      });

      await service(fixture.mediaService, "mediaService.applyCollection", {
        titleId: fixture.titles.allAges,
        collection,
      });
    }, 60_000);

    it("shows cast, crew, scores, studios, the trailer, and the collection on the title", async () => {
      const title = await run(fixture.member, "titles.get", {
        profileId: fixture.memberProfile,
        titleId: fixture.titles.allAges,
      });

      expect(title.cast.map((entry) => [entry.name, entry.role])).toStrictEqual([
        [`Lead ${TOKEN}`, "Role of Lead"],
        [`Second ${TOKEN}`, "Role of Second"],
      ]);
      expect(title.crew.map((entry) => [entry.name, entry.kind])).toStrictEqual([
        [`Maker ${TOKEN}`, "director"],
      ]);
      expect(title.ratings.imdb).toStrictEqual({ value: 8.7, votes: 2_000_000 });
      expect(title.ratings.rottenTomatoes).toBe(88);
      expect(title.studios).toStrictEqual([`Studio ${id}`]);
      expect(title.tags).toStrictEqual([`tag-${id}`]);
      expect(title.releaseDate).toBe("1999-03-31");
      expect(title.trailer).toStrictEqual({ site: "youtube", key: "dQw4w9WgXcQ", name: "Trailer" });
      expect(title.collection?.name).toBe(`Saga ${TOKEN}`);

      const adult = await run(fixture.member, "titles.get", {
        profileId: fixture.memberProfile,
        titleId: fixture.titles.adult,
      });

      expect(adult.trailer).toBeNull();
      expect(adult.cast.map((entry) => entry.name)).toStrictEqual([
        `Lead ${TOKEN}`,
        `Grown ${TOKEN}`,
      ]);
    });

    it("keeps one person when an IMDb-only credit and a TMDB credit name them", async () => {
      const imdbOnly = {
        person: {
          name: `Twice ${TOKEN}`,
          externalIds: { tmdb: null, imdb: `nm${id}`, tvdb: null },
          profile: null,
        },
        kind: "actor" as const,
        role: null,
        order: 0,
      };

      const tmdbOnly = {
        ...imdbOnly,
        person: { ...imdbOnly.person, externalIds: { tmdb: `twice${id}`, imdb: null, tvdb: null } },
      };

      await service(fixture.mediaService, "mediaService.applyCredits", {
        titleId: fixture.titles.unrated,
        episodeId: null,
        credits: [imdbOnly],
        hash: "twice-v1",
      });

      await service(fixture.mediaService, "mediaService.applyCredits", {
        titleId: fixture.titles.show,
        episodeId: null,
        credits: [tmdbOnly],
        hash: "twice-v2",
      });

      // Search matches any word, so only this name counts.
      const found = (
        await run(fixture.owner, "people.search", {
          profileId: fixture.ownerProfile,
          query: `Twice ${TOKEN}`,
        })
      ).filter((person) => person.name === `Twice ${TOKEN}`);

      expect(found).toHaveLength(1);

      const twice = found[0]?.id;

      if (twice === undefined) throw new Error("Nobody was credited");

      const detail = await run(fixture.owner, "people.get", {
        profileId: fixture.ownerProfile,
        personId: twice,
      });

      expect(detail.externalIds).toStrictEqual({ tmdb: `twice${id}`, imdb: `nm${id}`, tvdb: null });
      expect(detail.credits.map((entry) => entry.title.id).toSorted()).toStrictEqual(
        [fixture.titles.unrated, fixture.titles.show].toSorted(),
      );
    });

    it("writes credits again only when their digest changes", async () => {
      const again = await service(fixture.mediaService, "mediaService.applyCredits", {
        titleId: fixture.titles.adult,
        episodeId: null,
        credits: [],
        hash: "adult-v2",
      });

      expect(again).toStrictEqual({ written: false, people: [] });
    });

    it("shows a person only through titles the profile may see", async () => {
      const lead = await findPerson(fixture.owner, fixture.ownerProfile, "Lead");
      const grown = await findPerson(fixture.owner, fixture.ownerProfile, "Grown");

      const forOwner = await run(fixture.owner, "people.get", {
        profileId: fixture.ownerProfile,
        personId: lead,
      });

      expect(forOwner.credits.map((entry) => entry.title.id).toSorted()).toStrictEqual(
        [fixture.titles.allAges, fixture.titles.adult, fixture.titles.hidden].toSorted(),
      );
      expect(forOwner.detailsPending).toBe(true);

      const forMember = await run(stranger.session, "people.get", {
        profileId: stranger.profile,
        personId: lead,
      });

      expect(forMember.credits.map((entry) => entry.title.id).toSorted()).toStrictEqual(
        [fixture.titles.allAges, fixture.titles.adult].toSorted(),
      );

      const forKids = await run(fixture.member, "people.get", {
        profileId: fixture.kidsProfile,
        personId: lead,
      });

      // The member was granted the restricted library; the kids profile still never sees R.
      expect(forKids.credits.map((entry) => entry.title.id).toSorted()).toStrictEqual(
        [fixture.titles.allAges, fixture.titles.hidden].toSorted(),
      );

      expect(
        await outcome(
          run(fixture.member, "people.get", { profileId: fixture.kidsProfile, personId: grown }),
        ),
      ).toBe("not_found");
      // Search matches any word, so other people of this run show up; never a hidden one.
      expect(await searchPeople(fixture.member, fixture.kidsProfile, "Grown")).not.toContain(grown);
      expect((await searchPeople(stranger.session, stranger.profile, "Grown"))[0]).toBe(grown);
    });

    it("queues one person job per request window and writes the details it fetches", async () => {
      const lead = await findPerson(fixture.owner, fixture.ownerProfile, "Lead");
      const args = { profileId: fixture.memberProfile, personId: lead };

      await run(fixture.member, "people.requestDetails", args);
      await run(fixture.member, "people.requestDetails", args);

      const queued = (await run(fixture.owner, "jobs.list", { kind: "person", limit: 100 })).filter(
        (job) => job.payload.kind === "person" && job.payload.personId === lead,
      );

      expect(queued).toHaveLength(1);
      const [job] = queued;

      if (job === undefined) throw new Error("No person job was queued");
      const workerId = `person-worker-${id}`;

      await service(fixture.mediaService, "mediaService.claimJob", {
        jobId: job.id,
        workerId,
        leaseMs: 60_000,
      });

      const target = await service(fixture.mediaService, "mediaService.personTarget", {
        personId: lead,
      });

      expect(target.externalIds.tmdb).toBe(`1${id}`);

      // A person job's lease covers its own person only.
      expect(
        await outcome(
          service(fixture.mediaService, "mediaService.applyPerson", {
            jobId: job.id,
            workerId,
            personId: await findPerson(fixture.owner, fixture.ownerProfile, "Maker"),
            details: {
              name: `Maker ${TOKEN}`,
              externalIds: { tmdb: null, imdb: null, tvdb: null },
              profile: null,
              biography: null,
              birthDate: null,
              deathDate: null,
              birthPlace: null,
              knownFor: null,
            },
          }),
        ),
      ).toBe("invalid_args");

      await service(fixture.mediaService, "mediaService.applyPerson", {
        jobId: job.id,
        workerId,
        personId: lead,
        details: {
          name: target.name,
          externalIds: { tmdb: target.externalIds.tmdb, imdb: "nm0000001", tvdb: null },
          profile: null,
          biography: "Plays leads.",
          birthDate: "1970-01-01",
          deathDate: null,
          birthPlace: "Montreal",
          knownFor: "Acting",
        },
      });

      await service(fixture.mediaService, "mediaService.completeJob", { jobId: job.id, workerId });

      const detail = await run(fixture.member, "people.get", args);

      expect(detail.biography).toBe("Plays leads.");
      expect(detail.externalIds.imdb).toBe("nm0000001");
      expect(detail.detailsPending).toBe(false);
    });

    it("filters lists by genre, years, studio, and score, and counts genres", async () => {
      const names = async (filters: ListFilters) =>
        (
          await run(stranger.session, "titles.list", {
            profileId: stranger.profile,
            kind: "movie",
            sort: "added",
            limit: 100,
            ...filters,
          })
        ).items.flatMap((title) => (title.name.includes(TOKEN) ? [title.name] : []));

      expect((await names({ genre: `genre ${id}` })).toSorted()).toStrictEqual(
        [`Adult ${TOKEN}`, `All Ages ${TOKEN}`].toSorted(),
      );
      expect(await names({ genre: `Genre ${id}`, yearFrom: 2010, yearTo: 2019 })).toStrictEqual([
        `Adult ${TOKEN}`,
      ]);
      expect(await names({ studio: `studio ${id}` })).toStrictEqual([`All Ages ${TOKEN}`]);
      expect(await names({ genre: `Genre ${id}`, minRating: 8 })).toStrictEqual([
        `All Ages ${TOKEN}`,
      ]);

      const genres = await run(fixture.member, "titles.genres", {
        profileId: fixture.kidsProfile,
        kind: "movie",
      });

      // All ages and the granted restricted title; the adult one is not the kids profile's.
      expect(genres.find((genre) => genre.name === `Genre ${id}`)?.count).toBe(2);
    });

    it("recommends provider matches the profile may see, then titles alike", async () => {
      const similar = async (session: Session, profileId: ProfileId) =>
        (await run(session, "titles.similar", { profileId, titleId: fixture.titles.allAges })).map(
          (title) => title.id,
        );

      // The restricted title is recommended, but this member was never granted its library.
      expect((await similar(stranger.session, stranger.profile))[0]).toBe(fixture.titles.adult);
      expect(await similar(stranger.session, stranger.profile)).not.toContain(
        fixture.titles.hidden,
      );
      expect(await similar(fixture.member, fixture.kidsProfile)).not.toContain(
        fixture.titles.adult,
      );
      expect(
        (
          await run(fixture.owner, "titles.similar", {
            profileId: fixture.ownerProfile,
            titleId: fixture.titles.allAges,
          })
        )
          .map((title) => title.id)
          .slice(0, 2),
      ).toStrictEqual([fixture.titles.adult, fixture.titles.hidden]);
    });

    it("shows a collection's visible titles in year order, and hides one with none", async () => {
      const { collection } = await run(fixture.member, "titles.get", {
        profileId: fixture.memberProfile,
        titleId: fixture.titles.allAges,
      });

      if (collection === null) throw new Error("The title lost its collection");

      const full = await run(fixture.member, "collections.get", {
        profileId: fixture.memberProfile,
        collectionId: collection.id,
      });

      expect(full.overview).toBe("Every film of the saga.");
      expect(full.titles.map((title) => title.id)).toStrictEqual([
        fixture.titles.allAges,
        fixture.titles.adult,
      ]);

      const forKids = await run(fixture.member, "collections.get", {
        profileId: fixture.kidsProfile,
        collectionId: collection.id,
      });

      expect(forKids.titles.map((title) => title.id)).toStrictEqual([fixture.titles.allAges]);

      await service(fixture.mediaService, "mediaService.applyCollection", {
        titleId: fixture.titles.allAges,
        collection: null,
      });

      expect(
        await outcome(
          run(fixture.member, "collections.get", {
            profileId: fixture.kidsProfile,
            collectionId: collection.id,
          }),
        ),
      ).toBe("not_found");
    });

    it("lists an episode's guest stars, score, and IDs", async () => {
      const [first] = await run(fixture.member, "titles.episodes", {
        profileId: fixture.memberProfile,
        titleId: fixture.titles.show,
        seasonNumber: 1,
      });

      if (first === undefined) throw new Error("The show has no episodes");

      await service(fixture.mediaService, "mediaService.upsertScanned", {
        libraryId: fixture.openLibrary,
        items: [
          scanned(
            `/stack-${id}/open/show/s01e01.mp4`,
            { kind: "show", name: `Show ${TOKEN}`, ageRating: 7 },
            { season: 1, episode: 1 },
            {
              episode: {
                rating: { value: 8.4, votes: 50 },
                externalIds: { tmdb: `episode${id}`, imdb: null, tvdb: null },
              },
            },
          ),
        ],
      });

      await service(fixture.mediaService, "mediaService.applyCredits", {
        titleId: fixture.titles.show,
        episodeId: first.id,
        credits: [
          { person: creditedPerson("Guest", null), kind: "guest-star", role: "Visitor", order: 0 },
        ],
        hash: "episode-v1",
      });

      const [episode] = await run(fixture.member, "titles.episodes", {
        profileId: fixture.memberProfile,
        titleId: fixture.titles.show,
        seasonNumber: 1,
      });

      expect(episode?.rating).toBe(8.4);
      expect(episode?.externalIds.tmdb).toBe(`episode${id}`);
      expect(episode?.credits.map((entry) => [entry.name, entry.kind])).toStrictEqual([
        [`Guest ${TOKEN}`, "guest-star"],
      ]);
    });
  });

  describe("every public function", () => {
    /** Convex Auth's own entry points; they sign in, sign out, and report a boolean. */
    const CONVEX_AUTH: ReadonlySet<string> = new Set([
      "auth:signIn",
      "auth:signOut",
      "auth:isAuthenticated",
    ]);

    const scopeOf = new Map<string, CommandAccess>(
      [...Object.values(commands), ...Object.values(mediaServiceFunctions)].flatMap(
        (command: AnyCommand) =>
          command.kind === "media" ? [] : [[command.function, command.scope] as const],
      ),
    );

    let functions: ReadonlyArray<PublicFunction>;
    let ids: ReadonlyMap<string, string>;

    beforeAll(async () => {
      // Every table an argument names needs one document; a fresh stack has no backups yet.
      if ((await run(fixture.owner, "backups.list", {})).length === 0) {
        await service(fixture.mediaService, "mediaService.syncBackups", {
          archives: [
            {
              fileName: `movies-manual-${id}.zip`,
              sizeBytes: Bytes.make(1),
              trigger: "manual",
              takenAt: EpochMillis.make(Date.now()),
            },
          ],
        });
      }

      functions = await publicFunctions();
      ids = sampleIds(functions.flatMap((fn) => tablesIn(fn.args)));
    });

    /** Calls the function with generated arguments; only how the call ends matters here. */
    const call = async (session: Session, fn: PublicFunction): Promise<void> => {
      const args = fn.args === null ? {} : toArgs(sampleValue(fn.args, ids));

      await Match.value(fn.kind).pipe(
        Match.when("query", () =>
          session.client.query(makeFunctionReference<"query">(fn.path), args),
        ),
        Match.when("mutation", () =>
          session.client.mutation(makeFunctionReference<"mutation">(fn.path), args),
        ),
        Match.when("action", () =>
          session.client.action(makeFunctionReference<"action">(fn.path), args),
        ),
        Match.exhaustive,
      );
    };

    /** The functions a session must be refused, with the code each call actually ended with. */
    const outcomesFor = async (session: Session, refused: (access: CommandAccess) => boolean) =>
      Promise.all(
        functions.flatMap((fn) => {
          const access = scopeOf.get(fn.path);

          return access === undefined || !refused(access)
            ? []
            : [outcome(call(session, fn)).then((code) => ({ path: fn.path, code }))];
        }),
      );

    it("finds every public function in the registry, except Convex Auth's", () => {
      expect(functions.length).toBeGreaterThan(100);
      expect(
        functions.flatMap((fn) =>
          scopeOf.has(fn.path) || CONVEX_AUTH.has(fn.path) ? [] : [fn.path],
        ),
      ).toStrictEqual([]);
    });

    it("lets anonymous callers reach only the public allowlist", async () => {
      expect(
        functions.flatMap((fn) => (scopeOf.get(fn.path) === "public" ? [fn.path] : [])).toSorted(),
      ).toStrictEqual([
        "deviceAuth:request",
        "deviceAuth:status",
        "invites:lookup",
        "setup:status",
      ]);

      const results = await outcomesFor(anonymous(url), (access) => access !== "public");

      expect(results.filter((result) => result.code !== "unauthenticated")).toStrictEqual([]);
    });

    it.each([
      { who: "the media service", session: (set: Fixture) => set.mediaService },
      { who: "a member", session: (set: Fixture) => set.member },
      { who: "a read-only key", session: (set: Fixture) => set.readKey },
    ])("refuses $who every scope its session lacks", async ({ session }) => {
      const caller = session(fixture);
      const viewer = await run(caller, "account.viewer", {});
      const held = new Set<CommandAccess>(["public", "authenticated", ...viewer.scopes]);
      const results = await outcomesFor(caller, (access) => !held.has(access));

      expect(results.length).toBeGreaterThan(10);
      expect(results.filter((result) => result.code !== "forbidden")).toStrictEqual([]);
    });
  });
});
