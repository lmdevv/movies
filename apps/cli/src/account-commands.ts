/** Shortcuts for signing in and out, the viewer, the default viewing profile, and API keys. */
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

import { commands } from "@movies/contracts/commands";
import { ApiKeyScope } from "@movies/contracts/scopes";
import { Auth, DeviceLogin, MoviesClient } from "@movies/sdk/effect";
import { Config, Effect, Option, Redacted, Schema, Struct } from "effect";
import { renderUnicodeCompact } from "uqr";

import { ConfigFileError, LoginRefused } from "./cli-errors";
import type { StoredProfile } from "./config";
import {
  layerProfileStorage,
  loadConfig,
  normalizeUrl,
  ServerUrl,
  setDefaultProfile,
  updateProfile,
} from "./config";
import { readStdin } from "./files";
import type { Invocation, ShortcutCommand } from "./invocation";
import {
  booleanFlag,
  encodeResult,
  requirePositional,
  resultOutcome,
  stringFlag,
  textOutcome,
  usage,
} from "./invocation";
import { Output } from "./output";
import { connect, openSdk, storageFailure } from "./session";

const isServerUrl = Schema.is(ServerUrl);

/** Reads a secret from an environment variable or, when piped, stdin. */
const readSecret = (invocation: Invocation, variable: string, what: string) =>
  Effect.gen(function* () {
    const fromEnv = yield* Config.option(Config.Redacted(variable)).pipe(
      Effect.orElseSucceed(() => Option.none<Redacted.Redacted>()),
    );

    if (Option.isSome(fromEnv)) return fromEnv.value;

    if (process.stdin.isTTY) {
      return yield* usage(invocation, `Pipe the ${what} on stdin or set ${variable}`);
    }

    const text = yield* Effect.tryPromise({
      try: readStdin,
      catch: (cause) =>
        new ConfigFileError({ path: "stdin", message: "Could not read stdin", cause }),
    });

    const secret = text.trim();

    if (secret.length === 0) return yield* usage(invocation, `The ${what} on stdin is empty`);

    return Redacted.make(secret);
  });

const login: ShortcutCommand = {
  path: "login",
  options: {
    server: { type: "string" },
    "media-url": { type: "string" },
    "api-key": { type: "string" },
    email: { type: "string" },
    password: { type: "boolean" },
  },
  positionals: false,
  run: (invocation) =>
    Effect.gen(function* () {
      const output = yield* Output;
      const { env, target, tokens } = invocation;

      const server = Option.orElse(
        Option.map(stringFlag(tokens, "server"), normalizeUrl),
        () => target.convexUrl,
      );

      if (Option.isNone(server) || !isServerUrl(server.value)) {
        return yield* usage(
          invocation,
          "login needs --server with the Convex URL, such as http://nas.tailnet.ts.net:3210",
        );
      }

      const mediaUrl = Option.orElse(
        Option.map(stringFlag(tokens, "media-url"), normalizeUrl),
        () => target.mediaUrl,
      );

      const apiKey = Option.orElse(Option.map(stringFlag(tokens, "api-key"), Redacted.make), () =>
        target.apiKeyFromEnvironment ? target.apiKey : Option.none(),
      );

      const previous = Option.filter(
        target.stored,
        (profile) => profile.convexUrl === server.value,
      );

      const base: StoredProfile = {
        convexUrl: server.value,
        deviceId: Option.match(previous, {
          onNone: () => `cli-${randomUUID()}`,
          onSome: (profile) => profile.deviceId,
        }),
        ...Option.match(mediaUrl, { onNone: () => ({}), onSome: (url) => ({ mediaUrl: url }) }),
        ...Option.match(
          Option.flatMap(previous, (profile) => Option.fromNullishOr(profile.viewingProfileId)),
          { onNone: () => ({}), onSome: (viewingProfileId) => ({ viewingProfileId }) },
        ),
        ...Option.match(apiKey, {
          onNone: () => ({}),
          onSome: (key) => ({ apiKey: Redacted.value(key) }),
        }),
      };

      const { client, auth } = yield* openSdk(
        server.value,
        mediaUrl,
        layerProfileStorage(env.configPath, target.name, Option.some(base)),
        env.configPath,
      );

      const email = stringFlag(tokens, "email");

      const signIn = (credentials: Auth.Credentials) =>
        auth
          .signIn(credentials)
          .pipe(
            Effect.catchTag("TokenStorageError", (error) =>
              Effect.fail(storageFailure(env.configPath)(error)),
            ),
          );

      if (Option.isSome(apiKey)) {
        yield* signIn(Auth.Credentials.ApiKey({ key: apiKey.value }));
      } else if (Option.isSome(email) || booleanFlag(tokens, "password")) {
        if (Option.isNone(email)) return yield* usage(invocation, "--password needs --email");
        const password = yield* readSecret(invocation, "MOVIES_PASSWORD", "password");

        yield* signIn(
          Auth.Credentials.Password({
            flow: "signIn",
            email: email.value,
            password,
            name: Option.none(),
            inviteCode: Option.none(),
          }),
        );
      } else {
        const pending = yield* DeviceLogin.start(`movies CLI on ${hostname()}`).pipe(
          Effect.provideService(Auth.Auth, auth),
          Effect.provideService(MoviesClient.MoviesClient, client),
        );

        if (invocation.format === "json") {
          yield* output.err(
            JSON.stringify({
              event: "device_code",
              userCode: pending.userCode,
              verificationUrl: pending.verificationUrl,
              expiresAt: pending.expiresAt,
            }),
          );
        } else {
          yield* output.err(
            [
              `Open ${pending.verificationUrl} on a signed-in device and confirm code ${pending.userCode}.`,
              "",
              renderUnicodeCompact(pending.verificationUrl),
              "Waiting for approval…",
            ].join("\n"),
          );
        }

        yield* pending.complete.pipe(
          Effect.catchTags({
            DeviceLoginRefused: (refused) =>
              Effect.fail(new LoginRefused({ message: refused.message })),
            TokenStorageError: (error) => Effect.fail(storageFailure(env.configPath)(error)),
          }),
        );
      }

      const viewer = yield* client.query("account.viewer", {});

      const viewingProfileId: Option.Option<string> =
        base.viewingProfileId !== undefined || !viewer.scopes.includes("read")
          ? Option.fromNullishOr(base.viewingProfileId)
          : Option.fromNullishOr((yield* client.query("profiles.list", {}))[0]?.id);

      // The new login replaces the profile's old key and settings; keep only the new session.
      yield* updateProfile(env.configPath, target.name, (profile) =>
        Option.some(
          Struct.assign(base, {
            ...Option.match(
              Option.flatMap(profile, (current) => Option.fromNullishOr(current.session)),
              { onNone: () => ({}), onSome: (session) => ({ session }) },
            ),
            ...Option.match(viewingProfileId, {
              onNone: () => ({}),
              onSome: (id) => ({ viewingProfileId: id }),
            }),
          }),
        ),
      );

      const config = yield* loadConfig(env.configPath);

      if (Option.isNone(Option.fromNullishOr(config.profiles[config.defaultProfile]))) {
        yield* setDefaultProfile(env.configPath, target.name);
      }

      const json = {
        server: server.value,
        profile: target.name,
        user: yield* encodeResult("account.viewer", commands["account.viewer"], viewer),
        viewingProfileId: Option.getOrNull(viewingProfileId),
      };

      return textOutcome(
        json,
        `Logged in to ${server.value} as ${viewer.user.email ?? viewer.user.name} (${viewer.user.role}, ${viewer.sessionKind}). Saved to ${env.configPath}.`,
      );
    }),
};

const logout: ShortcutCommand = {
  path: "logout",
  options: {},
  positionals: false,
  run: (invocation) =>
    Effect.gen(function* () {
      const output = yield* Output;
      const { env, target } = invocation;

      if (Option.isSome(target.convexUrl) && !target.apiKeyFromEnvironment) {
        const { auth } = yield* openSdk(
          target.convexUrl.value,
          target.mediaUrl,
          layerProfileStorage(env.configPath, target.name, Option.none()),
          env.configPath,
        );

        yield* auth.signOut.pipe(
          Effect.catchTag("TokenStorageError", (error) =>
            Effect.fail(storageFailure(env.configPath)(error)),
          ),
        );
      }

      yield* updateProfile(env.configPath, target.name, (profile) =>
        Option.map(profile, ({ apiKey: _apiKey, session: _session, ...rest }) => rest),
      );

      if (target.apiKeyFromEnvironment) {
        yield* output.err("MOVIES_API_KEY is still set in the environment and keeps working.");
      }

      return textOutcome({ ok: true }, "Logged out.");
    }),
};

const whoami: ShortcutCommand = {
  path: "whoami",
  options: {},
  positionals: false,
  run: (invocation) =>
    Effect.gen(function* () {
      const connection = yield* connect(invocation.env, invocation.target, "required");
      const viewer = yield* connection.withSession(connection.client.query("account.viewer", {}));

      const json = {
        server: connection.convexUrl,
        profile: invocation.target.name,
        deviceId: connection.deviceId,
        viewingProfileId: Option.getOrNull(connection.viewingProfileId),
        viewer: yield* encodeResult("account.viewer", commands["account.viewer"], viewer),
      };

      return textOutcome(
        json,
        [
          `${viewer.user.email ?? viewer.user.name} (${viewer.user.role}) on ${connection.convexUrl}`,
          `session: ${viewer.sessionKind}, scopes ${viewer.scopes.join(", ")}`,
          `device: ${connection.deviceId}`,
          `viewing profile: ${Option.getOrElse(connection.viewingProfileId, () => "none")}`,
        ].join("\n"),
      );
    }),
};

const profilesUse: ShortcutCommand = {
  path: "profiles use",
  options: {},
  positionals: true,
  run: (invocation) =>
    Effect.gen(function* () {
      const wanted = yield* requirePositional(invocation, "a profile ID or name");
      const connection = yield* connect(invocation.env, invocation.target, "required");
      const profiles = yield* connection.withSession(connection.client.query("profiles.list", {}));

      const profile = profiles.find(
        (candidate) =>
          candidate.id === wanted || candidate.name.toLowerCase() === wanted.toLowerCase(),
      );

      if (profile === undefined) {
        return yield* usage(
          invocation,
          `No profile "${wanted}"; choose one of ${profiles.map((p) => `${p.name} (${p.id})`).join(", ")}`,
        );
      }

      // An install that runs on environment variables alone has no stored profile yet; it gets
      // one with the server, its device, and the choice, but never the key from the environment.
      yield* updateProfile(invocation.env.configPath, invocation.target.name, (stored) =>
        Option.some(
          Option.match(stored, {
            onSome: (current) => Struct.assign(current, { viewingProfileId: profile.id }),
            onNone: (): StoredProfile => ({
              convexUrl: connection.convexUrl,
              deviceId: connection.deviceId,
              viewingProfileId: profile.id,
              ...Option.match(connection.target.mediaUrl, {
                onNone: () => ({}),
                onSome: (mediaUrl) => ({ mediaUrl }),
              }),
            }),
          }),
        ),
      );

      return textOutcome(
        { viewingProfileId: profile.id, name: profile.name },
        `Commands now use the profile ${profile.name} (${profile.id}).`,
      );
    }),
};

const parseScopes = Schema.decodeUnknownOption(
  Schema.Array(ApiKeyScope).check(Schema.isMinLength(1)),
);

const keysCreate: ShortcutCommand = {
  path: "keys create",
  options: { scopes: { type: "string" }, "expires-in-days": { type: "string" } },
  positionals: true,
  run: (invocation) =>
    Effect.gen(function* () {
      const output = yield* Output;
      const name = yield* requirePositional(invocation, "a key name");

      const scopes = parseScopes(
        Option.getOrElse(stringFlag(invocation.tokens, "scopes"), () => "")
          .split(",")
          .map((scope) => scope.trim())
          .filter((scope) => scope.length > 0),
      );

      if (Option.isNone(scopes)) {
        return yield* usage(
          invocation,
          "--scopes expects a comma list of read, play, manage, admin",
        );
      }

      const days = Option.map(stringFlag(invocation.tokens, "expires-in-days"), Number);

      if (Option.isSome(days) && !Number.isInteger(days.value)) {
        return yield* usage(invocation, "--expires-in-days expects a whole number of days");
      }

      const connection = yield* connect(invocation.env, invocation.target, "required");

      const created = yield* connection.withSession(
        connection.client.action("apiKeys.create", {
          name,
          scopes: scopes.value,
          ...Option.match(days, {
            onNone: () => ({}),
            onSome: (expiresInDays) => ({ expiresInDays }),
          }),
        }),
      );

      if (invocation.format === "table")
        yield* output.err("The secret is shown once; store it now.");

      return resultOutcome(
        commands["apiKeys.create"],
        yield* encodeResult("apiKeys.create", commands["apiKeys.create"], created),
      );
    }),
};

const keysList: ShortcutCommand = {
  path: "keys list",
  options: {},
  positionals: false,
  run: (invocation) =>
    Effect.gen(function* () {
      const connection = yield* connect(invocation.env, invocation.target, "required");
      const keys = yield* connection.withSession(connection.client.query("apiKeys.list", {}));

      return resultOutcome(
        commands["apiKeys.list"],
        yield* encodeResult("apiKeys.list", commands["apiKeys.list"], keys),
      );
    }),
};

const keysRevoke: ShortcutCommand = {
  path: "keys revoke",
  options: {},
  positionals: true,
  run: (invocation) =>
    Effect.gen(function* () {
      const wanted = yield* requirePositional(invocation, "an API key ID or name");
      const connection = yield* connect(invocation.env, invocation.target, "required");
      const keys = yield* connection.withSession(connection.client.query("apiKeys.list", {}));

      const matches = keys.filter(
        (key) => key.revokedAt === null && (key.id === wanted || key.name === wanted),
      );

      const [key] = matches;

      if (key === undefined || matches.length > 1) {
        return yield* usage(
          invocation,
          matches.length > 1
            ? `Several keys are named "${wanted}"; revoke one by ID`
            : `No active API key "${wanted}"; see movies keys list`,
        );
      }

      yield* connection.withSession(
        connection.client.mutate("apiKeys.revoke", { apiKeyId: key.id }),
      );

      return textOutcome({ ok: true, apiKeyId: key.id }, `Revoked ${key.name} (${key.id}).`);
    }),
};

/** The account shortcuts. */
export const accountCommands: ReadonlyArray<ShortcutCommand> = [
  login,
  logout,
  whoami,
  profilesUse,
  keysCreate,
  keysList,
  keysRevoke,
];
