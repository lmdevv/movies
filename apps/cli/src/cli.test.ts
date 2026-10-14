import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { registryEntries, shortcuts, visibleRegistryEntries } from "./catalog";
import { ExitCode } from "./cli-errors";
import { runInProcess } from "./testing/run-cli";

const home = mkdtempSync(join(tmpdir(), "movies-cli-test-"));

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

const env = { XDG_CONFIG_HOME: home, HOME: home };

const movies = (...argv: ReadonlyArray<string>) => runInProcess(argv, env);

describe("the movies command", () => {
  it("prints help and the version", async () => {
    const help = await movies("--help");

    expect(help.code).toBe(ExitCode.ok);
    expect(help.stdout).toContain("Usage: movies <command> [flags]");
    expect((await movies("--version")).stdout).toBe("0.1.0");
  });

  it("reaches every registry command, at its own path or through call", async () => {
    const runs = await Promise.all(
      registryEntries.map((entry) =>
        visibleRegistryEntries.includes(entry)
          ? movies(...entry.path.split(" "), "--help")
          : movies("call", entry.name, "--help"),
      ),
    );

    for (const [index, entry] of registryEntries.entries()) {
      expect(runs[index]?.code, entry.name).toBe(ExitCode.ok);
      expect(runs[index]?.stdout, entry.name).toContain(`Registry command ${entry.name}`);
    }
  });

  it("answers --help for every shortcut", async () => {
    const helped = shortcuts.filter(
      (shortcut) => shortcut.path !== "call" && shortcut.path !== "commands",
    );

    const runs = await Promise.all(
      helped.map((shortcut) => movies(...shortcut.path.split(" "), "--help")),
    );

    for (const [index, shortcut] of helped.entries()) {
      expect(runs[index]?.code, shortcut.path).toBe(ExitCode.ok);
      expect(runs[index]?.stdout, shortcut.path).toContain(`Usage: movies ${shortcut.path}`);
    }
  });

  it("offers --wait on every command that can queue a job", async () => {
    const help = await movies("migration", "import", "--help");

    expect(help.stdout).toContain("--wait");
  });

  it("accepts camelCase registry words", async () => {
    expect((await movies("apiKeys", "create", "--help")).stdout).toContain(
      "Registry command apiKeys.create",
    );
  });

  it("reports unknown commands as usage errors with suggestions", async () => {
    const run = await movies("room");

    expect(run.code).toBe(ExitCode.usage);
    expect(JSON.parse(run.stderr)).toMatchObject({ error: { code: "usage" } });
    expect(run.stderr).toContain("rooms");
  });

  it("validates arguments offline and names the flag", async () => {
    const missing = await movies("libraries", "create", "--name", "Films", "--kind", "movies");

    expect(missing.code).toBe(ExitCode.usage);
    expect(missing.stderr).toContain("--roots");

    const invalid = await movies(
      "libraries",
      "create",
      "--name",
      "Films",
      "--kind",
      "movies",
      "--roots",
      "relative/path",
    );

    expect(invalid.code).toBe(ExitCode.usage);
    expect(invalid.stderr).toContain("--roots");
  });

  it("asks to log in before calling the server", async () => {
    const run = await movies("account", "viewer");

    expect(run.code).toBe(ExitCode.unauthenticated);
    expect(JSON.parse(run.stderr)).toMatchObject({ error: { code: "not_logged_in" } });
  });

  it("prints human errors with --human", async () => {
    const run = await movies("account", "viewer", "--human");

    expect(run.stderr.startsWith("movies: Not logged in")).toBe(true);
  });

  it("rejects an unreadable config file with a config error", async () => {
    const bad = mkdtempSync(join(tmpdir(), "movies-bad-config-"));

    mkdirSync(join(bad, "movies"));
    writeFileSync(join(bad, "movies", "config.json"), "{not json");
    const run = await runInProcess(["whoami"], { XDG_CONFIG_HOME: bad });

    rmSync(bad, { recursive: true, force: true });
    expect(run.code).toBe(ExitCode.failed);
    expect(JSON.parse(run.stderr)).toMatchObject({ error: { code: "config_error" } });
  });

  it("never sends a stored profile's credentials to another server in MOVIES_CONVEX_URL", async () => {
    const other = mkdtempSync(join(tmpdir(), "movies-other-server-"));
    const path = join(other, "movies", "config.json");

    const stored = `${JSON.stringify({
      defaultProfile: "home",
      profiles: {
        home: {
          convexUrl: "https://home.example/convex",
          deviceId: "cli-home",
          apiKey: "mk_home",
          session: { token: "jwt-home", refreshToken: "refresh-home" },
        },
      },
    })}\n`;

    mkdirSync(join(other, "movies"));
    writeFileSync(path, stored);

    const overridden = { XDG_CONFIG_HOME: other, MOVIES_CONVEX_URL: "http://127.0.0.1:9" };
    // Nothing listens on the discard port: any request at all fails as unavailable (exit 9).
    const run = await runInProcess(["whoami"], overridden);
    const use = await runInProcess(["profiles", "use", "Kids"], overridden);
    const after = readFileSync(path, "utf8");

    rmSync(other, { recursive: true, force: true });
    expect(run.code).toBe(ExitCode.unauthenticated);
    expect(JSON.parse(run.stderr)).toMatchObject({ error: { code: "not_logged_in" } });
    expect(use.code).toBe(ExitCode.usage);
    expect(use.stderr).toContain("--profile <new-name>");
    expect(after).toBe(stored);
  });

  it("lists every command as JSON with argument schemas", async () => {
    const run = await movies("commands");

    for (const entry of registryEntries) expect(run.stdout).toContain(`"name": "${entry.name}"`);
  });

  it("keeps the agent skill's command reference current", async () => {
    const skill = readFileSync(
      join(import.meta.dirname, "..", "skills", "movies", "SKILL.md"),
      "utf8",
    );

    const reference = (await movies("commands", "--markdown")).stdout;

    expect(skill, "run pnpm --filter @movies/cli skill:reference").toContain(reference);
  });
});
