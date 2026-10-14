/**
 * The command tree: every registry command at `movies <group> <action>`, the shortcuts built on
 * top of the registry, help text, the machine-readable catalog behind `movies commands`, and the
 * command reference of the agent skill.
 */
import type { AnyCommand, CommandGroup } from "@movies/contracts/command";
import { commands, isCommandName } from "@movies/contracts/commands";
import type { CommandName } from "@movies/contracts/commands";
import { Match, Schema, SchemaAST } from "effect";

import { ExitCode } from "./cli-errors";
import type { FlagSet, FlagSpec } from "./flags";
import { deriveFlags, FlagType, flagTypeLabel, flagUsage, kebabCase } from "./flags";

/** A registry command as the CLI exposes it. */
export interface RegistryEntry {
  readonly name: CommandName;
  /** The words after `movies`: `api-keys create`. */
  readonly path: string;
  readonly flags: FlagSet;
  /** The result names a background job, so `--wait` can follow it. */
  readonly job: boolean;
}

/** Whether a result schema carries a `jobId` to follow. */
const returnsJob = (command: AnyCommand): boolean => {
  const ast = SchemaAST.toEncoded(command.result.ast);

  return (
    SchemaAST.isObjects(ast) && ast.propertySignatures.some((property) => property.name === "jobId")
  );
};

/** Every registry command in registry order. */
export const registryEntries: ReadonlyArray<RegistryEntry> = Object.keys(commands)
  .filter(isCommandName)
  .map((name) => ({
    name,
    path: name.split(".").map(kebabCase).join(" "),
    flags: deriveFlags(commands[name].args),
    job: returnsJob(commands[name]),
  }));

/** A command the CLI implements on top of the registry. */
export interface Shortcut {
  /** The words after `movies`: `rooms pause`. */
  readonly path: string;
  readonly synopsis: string;
  readonly summary: string;
  readonly section: "Account" | "Watching" | "Rooms" | "Administration" | "Reference";
}

/** Every shortcut. A shortcut with the same path as a registry command replaces it there. */
export const shortcuts: ReadonlyArray<Shortcut> = [
  {
    path: "login",
    synopsis:
      "login [--server <convex-url>] [--media-url <url>] [--api-key <key> | --email <email> --password]",
    summary:
      "Sign in: device login by default (prints a code, a URL, and a QR code, then waits); --api-key or --email with --password (read from stdin or MOVIES_PASSWORD)",
    section: "Account",
  },
  {
    path: "logout",
    synopsis: "logout",
    summary: "Sign out and forget the session",
    section: "Account",
  },
  {
    path: "whoami",
    synopsis: "whoami",
    summary: "Show the account, session scopes, server, device, and default viewing profile",
    section: "Account",
  },
  {
    path: "profiles use",
    synopsis: "profiles use <profile-id-or-name>",
    summary: "Choose the viewing profile commands use when --profile-id is not given",
    section: "Account",
  },
  {
    path: "keys create",
    synopsis: "keys create <name> --scopes <read|play|manage|admin,...> [--expires-in-days <int>]",
    summary: "Create an API key; the secret is printed once",
    section: "Account",
  },
  {
    path: "keys list",
    synopsis: "keys list",
    summary: "List this account's API keys",
    section: "Account",
  },
  {
    path: "keys revoke",
    synopsis: "keys revoke <api-key-id-or-name>",
    summary: "Revoke an API key and end every session it signed in",
    section: "Account",
  },
  {
    path: "search",
    synopsis: "search <query> [--limit <int>]",
    summary: "Search titles on the default viewing profile",
    section: "Watching",
  },
  {
    path: "play",
    synopsis: "play <title> [--episode-id <id>] [--from <seconds>] [--max-height <lines>] [--open]",
    summary:
      "Start playback of a title ID or the best name match (a show resumes its next episode) and print the stream URL for mpv or VLC; --max-height caps the picture, such as 720 on a slow link (a taller source is transcoded down); --open launches mpv",
    section: "Watching",
  },
  {
    path: "progress",
    synopsis: "progress [<title>]",
    summary: "Show a title's progress, or the recent watch history",
    section: "Watching",
  },
  {
    path: "continue",
    synopsis: "continue",
    summary: "List what to resume and which episodes come next",
    section: "Watching",
  },
  {
    path: "rooms create",
    synopsis: "rooms create <title> [--episode-id <id>] [--position <seconds>]",
    summary: "Start a watch room hosted by this device, paused at the position",
    section: "Rooms",
  },
  {
    path: "rooms join",
    synopsis: "rooms join <room-id>",
    summary: "Join a room on this device with the default viewing profile",
    section: "Rooms",
  },
  {
    path: "rooms play",
    synopsis: "rooms play [<room-id>] [--position <seconds>]",
    summary: "Host: play the room from its current position or --position",
    section: "Rooms",
  },
  {
    path: "rooms pause",
    synopsis: "rooms pause [<room-id>]",
    summary: "Host: pause the room at its live position",
    section: "Rooms",
  },
  {
    path: "rooms seek",
    synopsis: "rooms seek [<room-id>] --position <seconds>",
    summary: "Host: move the room to a position",
    section: "Rooms",
  },
  {
    path: "rooms leave",
    synopsis: "rooms leave [<room-id>]",
    summary: "Leave the room; a host leaving ends it",
    section: "Rooms",
  },
  {
    path: "rooms status",
    synopsis: "rooms status [<room-id>] [--watch]",
    summary: "Show the room's clock, live position, and members; --watch prints every change",
    section: "Rooms",
  },
  {
    path: "scan",
    synopsis: "scan [<library-id-or-name>] [--mode quick|full] [--wait [--timeout <seconds>]]",
    summary: "Scan one library, or every library, for new, changed, and missing files",
    section: "Administration",
  },
  {
    path: "import",
    synopsis:
      "import jellyfin|plex --url <server-url> [--user <jellyfin-admin>] [--path-map <source-folder>=<local-folder>,...] [--map <source-user-id>=<profile-id>|skip,...] [--dry-run] [--wait]",
    summary:
      "Migrate libraries, watch history, favorites, collections, and metadata overrides; the token (or --user's password) is read from stdin, MOVIES_IMPORT_TOKEN, or MOVIES_IMPORT_PASSWORD",
    section: "Administration",
  },
  {
    path: "backup",
    synopsis: "backup [--wait [--timeout <seconds>]]",
    summary: "Back up the database now",
    section: "Administration",
  },
  {
    path: "restore",
    synopsis: "restore <backup-file-or-id>",
    summary: "Restore the database from a backup; every session signs in again",
    section: "Administration",
  },
  {
    path: "commands",
    synopsis: "commands [--markdown]",
    summary: "List every command with its flags and argument JSON Schema",
    section: "Reference",
  },
  {
    path: "call",
    synopsis: "call <command-name> [--json <object>]",
    summary: "Run any registry command by its dotted name, such as rooms.pause",
    section: "Reference",
  },
];

const shortcutPaths: ReadonlySet<string> = new Set(shortcuts.map((shortcut) => shortcut.path));

/** Registry commands reachable at their own path (not replaced by a shortcut). */
export const visibleRegistryEntries: ReadonlyArray<RegistryEntry> = registryEntries.filter(
  (entry) => !shortcutPaths.has(entry.path),
);

/** The first word of every multi-word command: `rooms`, `api-keys`, ... */
export const groupWords: ReadonlySet<string> = new Set(
  [...registryEntries.map((entry) => entry.path), ...shortcutPaths].flatMap((path) => {
    const [first, second] = path.split(" ");

    return second === undefined || first === undefined ? [] : [first];
  }),
);

const positionalUsage = (spec: FlagSpec): string =>
  FlagType.$match(spec.type, {
    List: () => `<${spec.flag}...>`,
    Choice: ({ choices }) => `<${choices.join("|")}>`,
    Text: () => `<${spec.flag}>`,
    Number: () => `<${spec.flag}>`,
    Boolean: () => `<${spec.flag}>`,
    Json: () => `<${spec.flag}>`,
  });

/** Required flags read as-is, optional and defaulted ones in brackets, boolean pairs in parentheses. */
const synopsisPart = (spec: FlagSpec): string => {
  if (!spec.required || spec.defaulted) return `[${flagUsage(spec)}]`;

  return FlagType.$is("Boolean")(spec.type) ? `(${flagUsage(spec)})` : flagUsage(spec);
};

/** `movies rooms get <room-id>`, `movies libraries create --name <text> ...` */
const synopsis = (entry: RegistryEntry): string => {
  const { flags, positional } = entry.flags;

  const parts = flags.map((spec) =>
    spec === positional ? positionalUsage(spec) : synopsisPart(spec),
  );

  const wait = entry.job ? ["[--wait [--timeout <seconds>]]"] : [];

  return ["movies", entry.path, ...parts, ...wait].join(" ");
};

const pad = (rows: ReadonlyArray<readonly [string, string]>): ReadonlyArray<string> => {
  const width = Math.min(48, Math.max(0, ...rows.map(([left]) => left.length)));

  return rows.map(([left, right]) =>
    left.length > width
      ? `  ${left}\n  ${"".padEnd(width)}  ${right}`
      : `  ${left.padEnd(width)}  ${right}`,
  );
};

/** The exit codes, one line. */
const exitCodeLine = `Exit codes: ${Object.entries(ExitCode)
  .map(([name, code]) => `${String(code)} ${name}`)
  .join(", ")}.`;

const globalFlagLines = pad([
  ["--format json|table", "Output format; JSON (the default) for agents, tables for people"],
  ["--human", "Same as --format table"],
  ["--profile <name>", "Use another stored server profile (or set MOVIES_PROFILE)"],
  ["-h, --help", "Show help for any command"],
  ["--version", "Print the version"],
]);

const shortcutRows = (section: Shortcut["section"]): ReadonlyArray<readonly [string, string]> =>
  shortcuts.flatMap((shortcut) =>
    shortcut.section === section ? [[shortcut.synopsis, shortcut.summary] as const] : [],
  );

/** `movies --help`. */
export const rootHelp = (version: string): string =>
  [
    `movies ${version}: the [movies] command line. Everything the app can do, for people and agents.`,
    "",
    "Usage: movies <command> [flags]",
    "",
    ...(["Account", "Watching", "Rooms", "Administration", "Reference"] as const).flatMap(
      (section) => Array.of<string>(section).concat(pad(shortcutRows(section)), [""]),
    ),
    "Commands (movies <group> --help lists a group)",
    ...pad([...groupWords].toSorted().map((group) => [group, groupSummary(group)] as const)),
    "",
    "Global flags",
    ...globalFlagLines,
    "",
    exitCodeLine,
    'Output is JSON on stdout; errors are {"error":{"code","message"}} on stderr.',
  ].join("\n");

const groupSummary = (group: string): string => {
  const names = [
    ...visibleRegistryEntries.flatMap((entry) =>
      entry.path.startsWith(`${group} `) ? [entry.path.slice(group.length + 1)] : [],
    ),
    ...shortcuts.flatMap((shortcut) =>
      shortcut.path.startsWith(`${group} `) ? [shortcut.path.slice(group.length + 1)] : [],
    ),
  ];

  return [...new Set(names)].join(", ");
};

/** `movies rooms --help`. */
export const groupHelp = (group: string): string =>
  [
    `Usage: movies ${group} <command> [flags]`,
    "",
    ...pad([
      ...shortcuts.flatMap((shortcut) =>
        shortcut.path.startsWith(`${group} `)
          ? [[shortcut.synopsis, shortcut.summary] as const]
          : [],
      ),
      ...visibleRegistryEntries.flatMap((entry) =>
        entry.path.startsWith(`${group} `)
          ? [[`movies ${entry.path}`, commands[entry.name].summary] as const]
          : [],
      ),
    ]),
    "",
    `Run movies ${group} <command> --help for its flags.`,
  ].join("\n");

const flagNote = (spec: FlagSpec): string => {
  const parts = [spec.required && !spec.defaulted ? "required" : "optional"];

  if (spec.defaulted) {
    parts.push(
      spec.key === "deviceId"
        ? "defaults to this install's device"
        : "defaults to `movies profiles use`",
    );
  }

  if (FlagType.$is("List")(spec.type)) parts.push("repeat the flag or separate values with commas");

  return parts.join("; ");
};

const access = (command: AnyCommand): string =>
  Match.value(command.scope).pipe(
    Match.when("public", () => "no sign-in needed"),
    Match.when("authenticated", () => "any session"),
    Match.orElse((scope) => `scope ${scope}`),
  );

/** `movies libraries create --help`. */
export const commandHelp = (entry: RegistryEntry): string => {
  const command = commands[entry.name];
  const { flags, positional } = entry.flags;
  const flagRows = flags.map((spec) => [flagUsage(spec), flagNote(spec)] as const);

  const jobRows = entry.job
    ? ([
        ["--wait", "Wait for the job to finish, printing progress to stderr"],
        ["--timeout <seconds>", "Give up waiting after this long (default 3600)"],
      ] as const)
    : [];

  return [
    `Usage: ${synopsis(entry)}`,
    "",
    command.summary,
    "",
    `Registry command ${entry.name} (${command.kind}, ${access(command)}).`,
    ...(positional === null
      ? []
      : [`The ${positionalUsage(positional)} argument fills --${positional.flag}.`]),
    "",
    "Flags",
    ...pad([
      ...flagRows,
      ...jobRows,
      ["--json <object>", "Arguments as one JSON object; flags override its fields"],
    ]),
    "",
    exitCodeLine,
  ].join("\n");
};

/** Help for a shortcut. */
export const shortcutHelp = (shortcut: Shortcut): string =>
  [`Usage: movies ${shortcut.synopsis}`, "", `${shortcut.summary}.`, "", exitCodeLine].join("\n");

/** One entry of `movies commands`. A type alias so it stays assignable to JSON. */
export type CatalogEntry = {
  readonly name: string;
  readonly command: string;
  readonly synopsis: string;
  readonly group: CommandGroup | "shortcut";
  readonly kind: AnyCommand["kind"] | "shortcut";
  readonly scope: string;
  readonly job: boolean;
  readonly summary: string;
  readonly positional: string | null;
  readonly flags: ReadonlyArray<{
    readonly flag: string;
    readonly field: string;
    readonly type: string;
    readonly required: boolean;
  }>;
  /** JSON Schema (draft 2020-12) of the wire arguments; `--json` accepts a matching object. */
  readonly args: Schema.Json;
};

/** JSON Schema generation only emits JSON values; a mismatch is a defect. */
const toJson = Schema.decodeUnknownSync(Schema.Json);

const dialect = "https://json-schema.org/draft/2020-12/schema";

/**
 * The wire arguments as JSON Schema. Effect describes an empty struct as "anything but null";
 * agents read it better as an object with no properties, which is what the CLI sends.
 */
const argsJsonSchema = (args: Schema.Top): Schema.Json => {
  const ast = SchemaAST.toEncoded(args.ast);

  if (
    SchemaAST.isObjects(ast) &&
    ast.propertySignatures.length === 0 &&
    ast.indexSignatures.length === 0
  ) {
    return { $schema: dialect, type: "object", properties: {} };
  }

  const document = Schema.toJsonSchemaDocument(args);

  return toJson(
    Object.keys(document.definitions).length === 0
      ? { $schema: dialect, ...document.schema }
      : { $schema: dialect, ...document.schema, $defs: document.definitions },
  );
};

/** Every command: shortcuts, then registry commands, with flags and argument JSON Schema. */
export const catalog = (): ReadonlyArray<CatalogEntry> => [
  ...shortcuts.map((shortcut): CatalogEntry => ({
    name: shortcut.path,
    command: `movies ${shortcut.path}`,
    synopsis: `movies ${shortcut.synopsis}`,
    group: "shortcut",
    kind: "shortcut",
    scope: "varies",
    job: shortcut.synopsis.includes("--wait"),
    summary: shortcut.summary,
    positional: null,
    flags: [],
    args: { type: "object" },
  })),
  ...registryEntries.map((entry): CatalogEntry => {
    const command = commands[entry.name];
    const replaced = shortcutPaths.has(entry.path);

    return {
      name: entry.name,
      command: replaced ? `movies call ${entry.name}` : `movies ${entry.path}`,
      synopsis: replaced ? `movies call ${entry.name} --json <object>` : synopsis(entry),
      group: command.group,
      kind: command.kind,
      scope: command.scope,
      job: entry.job,
      summary: command.summary,
      positional: entry.flags.positional === null ? null : `--${entry.flags.positional.flag}`,
      flags: entry.flags.flags.map((spec) => ({
        flag: `--${spec.flag}`,
        field: spec.key,
        type: flagTypeLabel(spec),
        required: spec.required && !spec.defaulted,
      })),
      args: argsJsonSchema(command.args),
    };
  }),
];

/** The command reference section of the agent skill, generated from the registry. */
export const markdownReference = (): string => {
  const groups = new Map<CommandGroup, Array<RegistryEntry>>();

  for (const entry of registryEntries) {
    const group = commands[entry.name].group;

    groups.set(group, [...(groups.get(group) ?? []), entry]);
  }

  const shortcutSection = [
    "### Shortcuts",
    "",
    ...shortcuts.map((shortcut) => `- \`movies ${shortcut.synopsis}\`: ${shortcut.summary}.`),
  ].join("\n");

  const sections = [...groups].map(([group, entries]) =>
    [
      `### ${group}`,
      "",
      ...entries.map((entry) => {
        const command = commands[entry.name];
        const replaced = shortcutPaths.has(entry.path);
        const usage = replaced ? `movies call ${entry.name} --json <object>` : synopsis(entry);

        const notes = [access(command), entry.job ? "job: add `--wait`" : null].filter(
          (note) => note !== null,
        );

        return `- \`${usage}\`: ${command.summary}. (${notes.join("; ")})`;
      }),
    ].join("\n"),
  );

  return [
    "<!-- Generated from the command registry by `pnpm --filter @movies/cli skill:reference`. Do not edit by hand. -->",
    "",
    shortcutSection,
    "",
    ...sections.flatMap((section) => [section, ""]),
  ]
    .join("\n")
    .trimEnd();
};

/** The registry entry for a dotted name typed into `movies call`. */
export const entryNamed = (name: string): RegistryEntry | undefined =>
  registryEntries.find((entry) => entry.name === name);
