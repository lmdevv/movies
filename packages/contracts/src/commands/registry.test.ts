import { assert, describe, it } from "vitest";

import { mediaServiceFunctions } from "../media-service";
import type { AnyCommand, CommandGroup } from "./command";
import { commands, isCommandName } from "./registry";

const entries: ReadonlyArray<readonly [string, AnyCommand]> = Object.entries(commands);

const ADMIN_GROUPS: ReadonlySet<CommandGroup> = new Set(["users", "backups", "migration"]);

const MANAGE_GROUPS: ReadonlySet<CommandGroup> = new Set(["libraries", "jobs", "metadata"]);

describe("command registry", () => {
  it("names each Convex command after its function", () => {
    for (const [name, command] of [...entries, ...Object.entries(mediaServiceFunctions)]) {
      if (command.kind === "media") continue;

      assert.strictEqual(command.function, name.replace(".", ":"), name);
    }
  });

  it("gives every media command its own route under /api", () => {
    const routes = entries.flatMap(([, command]) =>
      command.kind === "media" ? [`${command.route.method} ${command.route.path}`] : [],
    );

    assert.isAbove(routes.length, 0);
    assert.strictEqual(new Set(routes).size, routes.length);
  });

  it("keeps administration behind admin and manage scopes", () => {
    for (const [name, command] of entries) {
      if (ADMIN_GROUPS.has(command.group)) assert.strictEqual(command.scope, "admin", name);

      if (MANAGE_GROUPS.has(command.group)) assert.strictEqual(command.scope, "manage", name);
    }
  });

  it("keeps the media-service scope out of user commands and on every service function", () => {
    for (const [name, command] of entries) {
      assert.notStrictEqual(command.scope, "media-service", name);
      assert.notStrictEqual(command.group, "media-service", name);
    }

    for (const [name, command] of Object.entries(mediaServiceFunctions)) {
      assert.strictEqual(command.scope, "media-service", name);
    }
  });

  it("allows anonymous calls only for setup, invite lookup, and device sign-in", () => {
    const anonymous = entries.flatMap(([name, command]) =>
      command.scope === "public" ? [name] : [],
    );

    assert.sameMembers(anonymous, [
      "setup.status",
      "invites.lookup",
      "deviceAuth.request",
      "deviceAuth.status",
    ]);
  });

  it("recognizes registered names only", () => {
    assert.isTrue(isCommandName("titles.list"));
    assert.isFalse(isCommandName("titles.delete"));
    assert.isFalse(isCommandName("mediaService.claimJob"));
  });
});
