/**
 * Command definitions. A command is one user action: the web app, the command menu, the CLI, and
 * the agent skill all call it through the SDK by name. Convex commands name the public Convex
 * function that implements them; `media` commands name the media service HTTP route.
 */
import type { Schema } from "effect";

import type { CommandAccess } from "../scopes";

/** Where a command appears in the command menu and in CLI help. */
export type CommandGroup =
  | "setup"
  | "account"
  | "profiles"
  | "browse"
  | "history"
  | "playback"
  | "rooms"
  | "libraries"
  | "jobs"
  | "metadata"
  | "users"
  | "invites"
  | "keys"
  | "devices"
  | "sessions"
  | "backups"
  | "migration"
  | "diagnostics"
  | "media-service";

/** A Convex function path such as `titles:list`: the module under `convex/`, a colon, and the export. */
export type FunctionPath = `${string}:${string}`;

/** A schema for wire values: no services needed to decode or encode it. */
export type WireSchema = Schema.Codec<unknown>;

/** Arguments are always an object, matching Convex's object argument validators. */
export type ArgsSchema = WireSchema & { readonly fields: Schema.Struct.Fields };

/** Fields every command shares. */
interface CommandBase<Args extends ArgsSchema, Result extends WireSchema> {
  /** One line for the command menu and CLI help. */
  readonly summary: string;
  readonly group: CommandGroup;
  /** Who may call it; the server enforces this on every call. */
  readonly scope: CommandAccess;
  readonly args: Args;
  readonly result: Result;
}

/** A command implemented by a public Convex query, mutation, or action. */
export interface ConvexCommand<
  Kind extends "query" | "mutation" | "action",
  Args extends ArgsSchema,
  Result extends WireSchema,
> extends CommandBase<Args, Result> {
  readonly kind: Kind;
  readonly function: FunctionPath;
}

/**
 * A command implemented by the media service over HTTP. The SDK sends the caller's Convex auth
 * token as a bearer token; the media service checks the scope by calling `account.viewer` with it.
 */
export interface MediaCommand<
  Args extends ArgsSchema,
  Result extends WireSchema,
> extends CommandBase<Args, Result> {
  readonly kind: "media";
  readonly route: { readonly method: "GET" | "POST"; readonly path: `/api/${string}` };
}

/** Any command. */
export type AnyCommand =
  | ConvexCommand<"query" | "mutation" | "action", ArgsSchema, WireSchema>
  | MediaCommand<ArgsSchema, WireSchema>;

type Definition<Command> = Omit<Command, "kind">;

/** Defines a query command. Queries read state and can be subscribed to. */
export const query = <Args extends ArgsSchema, Result extends WireSchema>(
  definition: Definition<ConvexCommand<"query", Args, Result>>,
): ConvexCommand<"query", Args, Result> => ({ ...definition, kind: "query" });

/** Defines a mutation command. Mutations change state transactionally. */
export const mutation = <Args extends ArgsSchema, Result extends WireSchema>(
  definition: Definition<ConvexCommand<"mutation", Args, Result>>,
): ConvexCommand<"mutation", Args, Result> => ({ ...definition, kind: "mutation" });

/** Defines an action command. Actions mint secrets with real randomness before writing. */
export const action = <Args extends ArgsSchema, Result extends WireSchema>(
  definition: Definition<ConvexCommand<"action", Args, Result>>,
): ConvexCommand<"action", Args, Result> => ({ ...definition, kind: "action" });

/** Defines a command the media service serves over HTTP. */
export const media = <Args extends ArgsSchema, Result extends WireSchema>(
  definition: Definition<MediaCommand<Args, Result>>,
): MediaCommand<Args, Result> => ({ ...definition, kind: "media" });
