/** Shortcuts for scans, migration from Jellyfin or Plex, backups, and restore. */
import { commands } from "@movies/contracts/commands";
import { NotFound } from "@movies/contracts/errors";
import type { JobId } from "@movies/contracts/ids";
import { ProfileId } from "@movies/contracts/ids";
import type { Job } from "@movies/contracts/models/jobs";
import { MigrationSource } from "@movies/contracts/models/jobs";
import { Config, Effect, Option, Redacted, Schema, Struct } from "effect";

import { ConfigFileError } from "./cli-errors";
import { readStdin } from "./files";
import type { Invocation, ShortcutCommand } from "./invocation";
import {
  booleanFlag,
  encodeResult,
  positionalText,
  requirePositional,
  resultOutcome,
  stringFlag,
  textOutcome,
  timeoutFlag,
  usage,
} from "./invocation";
import { progressLine, waitForJob } from "./jobs";
import type { Connection } from "./session";
import { connect } from "./session";

const encodeJob = Schema.encodeSync(Schema.toCodecJson(commands["jobs.get"].result));

/** Follows `jobIds` when `--wait` was given; otherwise returns no jobs. */
const followJobs = Effect.fn("Admin.followJobs")(function* (
  invocation: Invocation,
  connection: Connection,
  jobIds: ReadonlyArray<JobId>,
) {
  if (!booleanFlag(invocation.tokens, "wait")) return [];
  const timeout = yield* timeoutFlag(invocation);

  return yield* Effect.forEach(jobIds, (jobId) =>
    waitForJob(connection.client, jobId, { progress: true, timeout }),
  );
});

const jobsOutcome = (base: Schema.JsonObject, jobs: ReadonlyArray<Job>, queued: string) =>
  textOutcome(
    jobs.length === 0 ? base : Struct.assign(base, { jobs: jobs.map((job) => encodeJob(job)) }),
    jobs.length === 0 ? queued : jobs.map(progressLine).join("\n"),
  );

const waitOptions = { wait: { type: "boolean" }, timeout: { type: "string" } } as const;

const scan: ShortcutCommand = {
  path: "scan",
  options: { mode: { type: "string" }, ...waitOptions },
  positionals: true,
  run: (invocation) =>
    Effect.gen(function* () {
      const mode = stringFlag(invocation.tokens, "mode");

      if (Option.isSome(mode) && mode.value !== "quick" && mode.value !== "full") {
        return yield* usage(invocation, "--mode must be quick or full");
      }

      const connection = yield* connect(invocation.env, invocation.target, "required");

      const libraries = yield* connection.withSession(
        connection.client.query("libraries.listDetails", {}),
      );

      const wanted = positionalText(invocation.tokens);

      const chosen = Option.match(wanted, {
        onNone: () => libraries,
        onSome: (name) =>
          libraries.filter(
            (library) => library.id === name || library.name.toLowerCase() === name.toLowerCase(),
          ),
      });

      if (chosen.length === 0) {
        return yield* new NotFound({
          message: Option.match(wanted, {
            onNone: () => "There are no libraries to scan",
            onSome: (name) => `No library "${name}"; see movies libraries list-details`,
          }),
        });
      }

      const queued = yield* Effect.forEach(chosen, (library) =>
        connection.withSession(
          connection.client.mutate("libraries.scan", {
            libraryId: library.id,
            ...Option.match(mode, {
              onNone: () => ({}),
              onSome: (value) => ({
                mode: value === "quick" ? ("quick" as const) : ("full" as const),
              }),
            }),
          }),
        ),
      );

      const jobs = yield* followJobs(
        invocation,
        connection,
        queued.map((job) => job.jobId),
      );

      return jobsOutcome(
        { jobIds: queued.map((job) => job.jobId) },
        jobs,
        `Queued ${String(queued.length)} scan${queued.length === 1 ? "" : "s"}: ${queued.map((job) => job.jobId).join(", ")}`,
      );
    }),
};

/** `sourceUser=profileId,...` pairs for `--map`. */
const parseMappings = (invocation: Invocation) =>
  Effect.forEach(
    Option.getOrElse(stringFlag(invocation.tokens, "map"), () => "")
      .split(",")
      .map((pair) => pair.trim())
      .filter((pair) => pair.length > 0),
    (pair) => {
      const [sourceUserId, profileId, ...rest] = pair.split("=");

      return sourceUserId === undefined ||
        profileId === undefined ||
        rest.length > 0 ||
        sourceUserId.length === 0
        ? Effect.fail(
            usage(invocation, `--map expects <source-user-id>=<profile-id>, got "${pair}"`),
          )
        : Effect.succeed({ sourceUserId, profileId: ProfileId.make(profileId) });
    },
  );

const isMigrationSource = Schema.is(MigrationSource);

/** The source server's token: `MOVIES_IMPORT_TOKEN`, or stdin when piped. */
const importToken = (invocation: Invocation) =>
  Effect.gen(function* () {
    const fromEnv = yield* Config.option(Config.Redacted("MOVIES_IMPORT_TOKEN")).pipe(
      Effect.orElseSucceed(() => Option.none<Redacted.Redacted>()),
    );

    if (Option.isSome(fromEnv)) return Redacted.value(fromEnv.value);

    if (process.stdin.isTTY) {
      return yield* usage(
        invocation,
        "Pipe the source server's token on stdin or set MOVIES_IMPORT_TOKEN",
      );
    }

    const text = yield* Effect.tryPromise({
      try: readStdin,
      catch: (cause) =>
        new ConfigFileError({ path: "stdin", message: "Could not read stdin", cause }),
    });

    return text.trim();
  });

const migrate: ShortcutCommand = {
  path: "import",
  options: {
    url: { type: "string" },
    map: { type: "string" },
    "dry-run": { type: "boolean" },
    ...waitOptions,
  },
  positionals: true,
  run: (invocation) =>
    Effect.gen(function* () {
      const source = yield* requirePositional(invocation, "jellyfin or plex");

      if (!isMigrationSource(source))
        return yield* usage(invocation, "import needs jellyfin or plex");
      const url = stringFlag(invocation.tokens, "url");

      if (Option.isNone(url))
        return yield* usage(invocation, "import needs --url <source server URL>");
      const users = yield* parseMappings(invocation);
      const token = yield* importToken(invocation);
      const connection = yield* connect(invocation.env, invocation.target, "required");

      const connected = yield* connection.withSession(
        connection.client.media("migration.connect", { source, url: url.value, token }),
      );

      const plan = { connectionId: connected.connectionId, users };

      if (booleanFlag(invocation.tokens, "dry-run")) {
        const report = yield* connection.withSession(
          connection.client.media("migration.dryRun", plan),
        );

        return resultOutcome(
          commands["migration.dryRun"],
          yield* encodeResult("migration.dryRun", commands["migration.dryRun"], report),
        );
      }

      const queued = yield* connection.withSession(
        connection.client.media("migration.import", plan),
      );

      const jobs = yield* followJobs(invocation, connection, [queued.jobId]);

      return jobsOutcome({ jobId: queued.jobId }, jobs, `Queued migration job ${queued.jobId}`);
    }),
};

const backup: ShortcutCommand = {
  path: "backup",
  options: waitOptions,
  positionals: false,
  run: (invocation) =>
    Effect.gen(function* () {
      const connection = yield* connect(invocation.env, invocation.target, "required");
      const queued = yield* connection.withSession(connection.client.mutate("backups.run", {}));
      const jobs = yield* followJobs(invocation, connection, [queued.jobId]);

      return jobsOutcome({ jobId: queued.jobId }, jobs, `Queued backup job ${queued.jobId}`);
    }),
};

const restore: ShortcutCommand = {
  path: "restore",
  options: {},
  positionals: true,
  run: (invocation) =>
    Effect.gen(function* () {
      const wanted = yield* requirePositional(invocation, "a backup file name or ID");
      const connection = yield* connect(invocation.env, invocation.target, "required");
      const backups = yield* connection.withSession(connection.client.query("backups.list", {}));
      const name = wanted.split("/").at(-1) ?? wanted;

      const found = backups.find(
        (candidate) => candidate.id === wanted || candidate.fileName === name,
      );

      if (found === undefined) {
        return yield* new NotFound({ message: `No backup "${wanted}"; see movies backups list` });
      }

      yield* connection.withSession(
        connection.client.media("backups.restore", { backupId: found.id }),
      );

      return textOutcome(
        { ok: true, backupId: found.id, fileName: found.fileName },
        `Restored ${found.fileName}. Every session signs in again.`,
      );
    }),
};

/** The administration shortcuts. */
export const adminCommands: ReadonlyArray<ShortcutCommand> = [scan, migrate, backup, restore];
