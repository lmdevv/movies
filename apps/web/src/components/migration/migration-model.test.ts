import {
  MigrationConnection,
  MigrationReport,
  MigrationRun,
} from "@movies/contracts/models/migration";
import type { MigrationPhase } from "@movies/contracts/models/migration";
import { ProfileId, UserId } from "@movies/contracts/ids";
import * as fc from "fast-check";
import { Option, Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  SKIP,
  currentMappings,
  failureLine,
  importFraction,
  importMinutesLeft,
  mappingsWith,
  userRows,
  withChoice,
} from "./migration-model";

const PHASES: ReadonlyArray<MigrationPhase> = [
  "libraries",
  "scanning",
  "watchState",
  "collections",
  "overrides",
];

const run = (
  phase: MigrationPhase,
  done: number,
  total: number | null,
  status: "pending" | "running" | "succeeded" = "running",
): MigrationRun =>
  Schema.decodeSync(MigrationRun)({
    job: {
      id: "job1",
      kind: "migration",
      status,
      payload: { kind: "migration", source: "jellyfin", serverName: "Home" },
      progress: { done, total, message: null },
      error: null,
      requestedBy: null,
      attempts: 1,
      createdAt: 0,
      startedAt: 0,
      finishedAt: null,
    },
    source: "jellyfin",
    serverName: "Home",
    phase,
    imported: {
      librariesAdded: 0,
      watched: 0,
      inProgress: 0,
      playCounts: 0,
      favorites: 0,
      collections: 0,
      overrides: 0,
      keptLocal: 0,
      unmatched: 0,
    },
  });

const alex = Schema.decodeSync(ProfileId)("profile-alex");

const kids = Schema.decodeSync(ProfileId)("profile-kids");

const sam = Schema.decodeSync(ProfileId)("profile-sam");

const samAccount = Schema.decodeSync(UserId)("user-sam");

const connection = Schema.decodeSync(MigrationConnection)({
  status: "connected",
  connectionId: "c1",
  source: "jellyfin",
  serverName: "Home",
  version: "10.10.3",
  users: [
    {
      sourceUserId: "jf-admin",
      name: "admin",
      email: null,
      isAdmin: true,
      suggestion: { kind: "invite" },
      history: "full",
    },
    {
      sourceUserId: "jf-sam",
      name: "sam",
      email: "sam@example.com",
      isAdmin: false,
      suggestion: { kind: "profile", userId: samAccount, profileId: sam, matchedBy: "email" },
      history: "full",
    },
  ],
  libraries: [],
  pathMappings: [
    { from: "/data/movies", to: "/mnt/nas/movies", inferred: true },
    { from: "/srv", to: "/mnt/srv", inferred: false },
  ],
  expiresAt: 0,
});

const report = Schema.decodeSync(MigrationReport)({
  status: "ready",
  connectionId: "c1",
  source: "jellyfin",
  serverName: "Home",
  createdAt: 0,
  summary: {
    usersMapped: 1,
    usersUnmapped: 1,
    librariesToAdd: 0,
    librariesExisting: 0,
    itemsByPath: 0,
    itemsByProviderId: 0,
    itemsAwaitingScan: 0,
    itemsUnmatched: 0,
    watched: 0,
    inProgress: 0,
    playCounts: 0,
    favorites: 0,
    collections: 0,
    overrides: 0,
    conflicts: 0,
  },
  users: [
    { sourceUserId: "jf-admin", name: "admin", profileId: null, action: "invite" },
    { sourceUserId: "jf-sam", name: "sam", profileId: sam, action: "import" },
  ],
  libraries: [],
  unmatchedSamples: [],
});

const own = [
  { id: alex, name: "Alex" },
  { id: kids, name: "Kids" },
];

const plexFailure = (reason: "auth_failed" | "not_admin" | "unreachable") =>
  failureLine({ status: "failed", reason, message: "" }, "plex");

describe("source failures", () => {
  it("shows credential failures under the key and address failures under the URL", () => {
    expect(plexFailure("auth_failed")).toEqual({
      field: "token",
      message: "Plex didn’t accept this token.",
    });
    expect(plexFailure("not_admin").field).toBe("token");
    expect(plexFailure("unreachable")).toEqual({
      field: "url",
      message: "Nothing answered at this address.",
    });
  });

  it("passes the server's own words through for an unsupported version", () => {
    expect(
      failureLine(
        { status: "failed", reason: "version_unsupported", message: "Jellyfin 10.7 is too old." },
        "jellyfin",
      ).message,
    ).toBe("Jellyfin 10.7 is too old.");
  });
});

describe("import progress", () => {
  it("never runs backwards, though job progress starts over at each phase", () => {
    const point = fc
      .record({
        phase: fc.integer({ min: 0, max: PHASES.length - 1 }),
        total: fc.integer({ min: 1, max: 10_000 }),
        done: fc.nat(10_000),
      })
      .map(({ phase, total, done }) => ({ phase, total, done: Math.min(done, total) }));

    const at = (p: { readonly phase: number; readonly done: number; readonly total: number }) =>
      importFraction(run(PHASES[p.phase] ?? "libraries", p.done, p.total));

    fc.assert(
      fc.property(point, point, (a, b) => {
        const [earlier, later] =
          a.phase < b.phase || (a.phase === b.phase && a.done / a.total <= b.done / b.total)
            ? [a, b]
            : [b, a];

        expect(at(earlier)).toBeGreaterThanOrEqual(0);
        expect(at(earlier)).toBeLessThanOrEqual(at(later) + 1e-9);
        expect(at(later)).toBeLessThanOrEqual(1);
      }),
    );
  });

  it("is complete once the import succeeded", () => {
    expect(importFraction(run("overrides", 0, null, "succeeded"))).toBe(1);
    expect(importFraction(run("done", 0, null))).toBe(1);
  });

  it("estimates minutes left from the pace so far", () => {
    // A quarter done in two minutes: six minutes left.
    expect(importMinutesLeft(run("watchState", 0, null), 0.25, 120_000)).toBe(6);
    expect(importMinutesLeft(run("libraries", 0, null), 0.01, 120_000)).toBeNull();
  });
});

describe("user mappings", () => {
  const rows = userRows(connection, report, own, [{ id: samAccount, name: "Sam" }]);

  it("offers the suggested account, the admin's own profiles, and skipping", () => {
    expect(rows.map((row) => [row.name, row.choice, row.options.map((o) => o.label)])).toEqual([
      ["admin", SKIP, ["Alex", "Kids", "Don’t import"]],
      ["sam", sam, ["Sam", "Alex", "Kids", "Don’t import"]],
    ]);
  });

  it("changes one user's choice and keeps the others", () => {
    expect(withChoice(rows, "jf-admin", alex)).toEqual([
      { sourceUserId: "jf-admin", profileId: alex },
      { sourceUserId: "jf-sam", profileId: sam },
    ]);
    expect(currentMappings(rows)).toEqual([
      { sourceUserId: "jf-admin", profileId: null },
      { sourceUserId: "jf-sam", profileId: sam },
    ]);
  });
});

describe("folder mappings", () => {
  it("keeps the mappings given at connect and leaves inferred ones to connect", () => {
    expect(mappingsWith(connection.pathMappings, "/data/shows", " /mnt/nas/tv ")).toEqual(
      Option.some([
        { from: "/srv", to: "/mnt/srv" },
        { from: "/data/shows", to: "/mnt/nas/tv" },
      ]),
    );
  });

  it("replaces an earlier mapping of the same folder", () => {
    expect(mappingsWith(connection.pathMappings, "/srv", "/mnt/other")).toEqual(
      Option.some([{ from: "/srv", to: "/mnt/other" }]),
    );
  });

  it("refuses a local folder that is not a full path", () => {
    expect(Option.isNone(mappingsWith(connection.pathMappings, "/data/shows", "nas/tv"))).toBe(
      true,
    );
  });
});
