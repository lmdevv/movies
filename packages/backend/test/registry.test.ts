/**
 * The command registry and the Convex functions agree: every Convex command and media service
 * function names an existing public function of the right kind whose argument and result
 * validators describe the same wire values as the contract's schemas; every public function is in
 * the registry; and constants duplicated across the seam are equal. Runs without a backend.
 */
import {
  HOST_ABANDON_TIMEOUT_MS,
  HOST_PRESENCE_TIMEOUT_MS,
  HOST_REANCHOR_THRESHOLD_MS,
  MEMBER_PRESENCE_TIMEOUT_MS,
} from "@movies/contracts/clock";
import type { AnyCommand } from "@movies/contracts/command";
import { commands } from "@movies/contracts/commands";
import { mediaServiceFunctions } from "@movies/contracts/media-service";
import {
  PLAYBACK_TOKEN_LIFETIME_MS,
  PLAYBACK_TOKEN_TEST_VECTORS,
} from "@movies/contracts/playback-token";
import { YOUTUBE_KEY_PATTERN } from "@movies/contracts/models/catalog";
import { Role, roleScopes } from "@movies/contracts/scopes";
import { Predicate } from "effect";
import { describe, expect, it } from "vitest";

import * as account from "../convex/account";
import * as apiKeys from "../convex/apiKeys";
import * as authParams from "../convex/authParams";
import * as backups from "../convex/backups";
import * as collections from "../convex/collections";
import * as deviceAuth from "../convex/deviceAuth";
import * as history from "../convex/history";
import * as invites from "../convex/invites";
import * as jobs from "../convex/jobs";
import * as libraries from "../convex/libraries";
import * as maintenance from "../convex/maintenance";
import * as mediaService from "../convex/mediaService";
import * as metadata from "../convex/metadata";
import * as migration from "../convex/migration";
import * as migrationService from "../convex/migrationService";
import * as myList from "../convex/myList";
import * as people from "../convex/people";
import * as playback from "../convex/playback";
import * as profiles from "../convex/profiles";
import * as rooms from "../convex/rooms";
import * as sessions from "../convex/sessions";
import * as setup from "../convex/setup";
import * as titles from "../convex/titles";
import * as users from "../convex/users";
import * as convexClock from "../convex/lib/roomClock";
import {
  PLAYBACK_TOKEN_LIFETIME_MS as CONVEX_TOKEN_LIFETIME_MS,
  signPlaybackToken,
} from "../convex/lib/playbackToken";
import { YOUTUBE_KEY } from "../convex/lib/catalog";
import { ROLE_SCOPES } from "../convex/lib/scopes";
import type { ValidatorJson } from "./validator-json";
import { normalizeValidator, parseExportedValidator, validatorFromSchema } from "./validator-json";

/** Every module with Convex functions except `auth.ts`, whose `signIn` and `signOut` are Convex Auth's. */
const modules = {
  account,
  apiKeys,
  authParams,
  backups,
  collections,
  deviceAuth,
  history,
  invites,
  jobs,
  libraries,
  maintenance,
  mediaService,
  metadata,
  migration,
  migrationService,
  myList,
  people,
  playback,
  profiles,
  rooms,
  sessions,
  setup,
  titles,
  users,
};

/** What the Convex runtime exposes about a registered function. */
interface RegisteredFunction {
  readonly kind: "query" | "mutation" | "action";
  readonly isPublic: boolean;
  readonly args: ValidatorJson | null;
  readonly returns: ValidatorJson | null;
}

type Modules = typeof modules;

/** Any function a listed module exports. */
type RegisteredExport = {
  [Name in keyof Modules]: Modules[Name][keyof Modules[Name]];
}[keyof Modules];

/** The Convex runtime's `exportArgs` and `exportReturns`; `parseExportedValidator` checks what they return. */
const isExporter = (value: unknown): value is () => string => Predicate.isFunction(value);

const exported = (registered: RegisteredExport, method: "exportArgs" | "exportReturns") => {
  if (!Predicate.hasProperty(registered, method) || !isExporter(registered[method])) {
    throw new Error(`Convex function has no ${method}`);
  }

  return parseExportedValidator(registered[method]());
};

const flag = (registered: RegisteredExport, name: "isQuery" | "isMutation" | "isPublic"): boolean =>
  Predicate.hasProperty(registered, name) && registered[name] === true;

const registry = new Map<string, RegisteredFunction>(
  Object.entries(modules).flatMap(([moduleName, module]) =>
    Object.entries<RegisteredExport>(module).map(
      ([exportName, registered]): [string, RegisteredFunction] => [
        `${moduleName}:${exportName}`,
        {
          kind: flag(registered, "isQuery")
            ? "query"
            : flag(registered, "isMutation")
              ? "mutation"
              : "action",
          isPublic: flag(registered, "isPublic"),
          args: exported(registered, "exportArgs"),
          returns: exported(registered, "exportReturns"),
        },
      ],
    ),
  ),
);

const convexCommands = [
  ...Object.entries(commands),
  ...Object.entries(mediaServiceFunctions),
].flatMap(([name, command]: [string, AnyCommand]) =>
  command.kind === "media" ? [] : [{ name, command }],
);

const normalized = (json: ValidatorJson | null | undefined) =>
  json === null || json === undefined ? null : normalizeValidator(json);

describe("registry and Convex functions", () => {
  it.each(convexCommands)("$name matches its Convex function", ({ command }) => {
    const registered = registry.get(command.function);

    expect(registered, `${command.function} is not exported`).toBeDefined();
    expect(registered?.kind).toBe(command.kind);
    expect(registered?.isPublic).toBe(true);
    expect(normalized(registered?.args)).toStrictEqual(
      normalized(validatorFromSchema(command.args.ast)),
    );
    expect(normalized(registered?.returns)).toStrictEqual(
      normalized(validatorFromSchema(command.result.ast)),
    );
  });

  it("lists every public Convex function in the registry", () => {
    const listed: ReadonlySet<string> = new Set(
      convexCommands.map(({ command }) => command.function),
    );

    const unlisted = [...registry.entries()].flatMap(([path, registered]) =>
      registered.isPublic && !listed.has(path) ? [path] : [],
    );

    expect(unlisted).toStrictEqual([]);
  });
});

describe("constants shared across the seam", () => {
  it("gives each role the same scopes", () => {
    for (const role of Role.literals) expect(ROLE_SCOPES[role]).toStrictEqual(roleScopes(role));
  });

  it("checks YouTube keys with the same pattern", () => {
    expect(YOUTUBE_KEY.source).toBe(YOUTUBE_KEY_PATTERN.source);
    expect(YOUTUBE_KEY.flags).toBe(YOUTUBE_KEY_PATTERN.flags);
  });

  it("uses the same room clock timings", () => {
    expect(convexClock.HOST_PRESENCE_TIMEOUT_MS).toBe(HOST_PRESENCE_TIMEOUT_MS);
    expect(convexClock.MEMBER_PRESENCE_TIMEOUT_MS).toBe(MEMBER_PRESENCE_TIMEOUT_MS);
    expect(convexClock.HOST_ABANDON_TIMEOUT_MS).toBe(HOST_ABANDON_TIMEOUT_MS);
    expect(convexClock.HOST_REANCHOR_THRESHOLD_MS).toBe(HOST_REANCHOR_THRESHOLD_MS);
  });

  it("signs the shared playback token vector exactly", async () => {
    const { payload, token } = PLAYBACK_TOKEN_TEST_VECTORS.valid;

    expect(CONVEX_TOKEN_LIFETIME_MS).toBe(PLAYBACK_TOKEN_LIFETIME_MS);

    await expect(
      signPlaybackToken(PLAYBACK_TOKEN_TEST_VECTORS.secret, {
        sub: payload.sub,
        pid: payload.pid,
        fid: payload.fid,
        sid: payload.sid,
        iat: payload.iat,
        exp: payload.exp,
      }),
    ).resolves.toBe(token);
  });
});
