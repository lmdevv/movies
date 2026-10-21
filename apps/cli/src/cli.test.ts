import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import packageJson from "../package.json" with { type: "json" };

import { accountCommands } from "./account-commands";
import { adminCommands } from "./admin-commands";
import { registryEntries, shortcuts, visibleRegistryEntries } from "./catalog";
import { ExitCode } from "./cli-errors";
import { diagnosticsCommands } from "./diagnostics-commands";
import { roomCommands } from "./room-commands";
import { withMediaService } from "./testing/media-service";
import type { CliRun } from "./testing/run-cli";
import { runInProcess } from "./testing/run-cli";
import { watchCommands } from "./watch-commands";

const home = mkdtempSync(join(tmpdir(), "movies-cli-test-"));

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

const env = { XDG_CONFIG_HOME: home, HOME: home };

const movies = (...argv: ReadonlyArray<string>) => runInProcess(argv, env);

/** A config home whose `home` profile is signed in to `convexUrl` with a key and a session. */
const storedHome = (convexUrl = "https://home.example/convex") => {
  const dir = mkdtempSync(join(tmpdir(), "movies-stored-home-"));
  const path = join(dir, "movies", "config.json");

  const stored = `${JSON.stringify({
    defaultProfile: "home",
    profiles: {
      home: {
        convexUrl,
        deviceId: "cli-home",
        apiKey: "mk_home",
        session: { token: "jwt-home", refreshToken: "refresh-home" },
      },
    },
  })}\n`;

  mkdirSync(join(dir, "movies"));
  writeFileSync(path, stored);

  return { home: dir, path, stored };
};

describe("the movies command", () => {
  it("prints help and the version", async () => {
    const help = await movies("--help");

    expect(help.code).toBe(ExitCode.ok);
    expect(help.stdout).toContain("Usage: movies <command> [flags]");
    expect((await movies("--version")).stdout).toBe(packageJson.version);
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

  it("documents exactly the shortcuts it implements", () => {
    const implemented = [
      ...accountCommands,
      ...watchCommands,
      ...roomCommands,
      ...adminCommands,
      ...diagnosticsCommands,
    ];

    // `call` and `commands` are routed before any shortcut.
    const routed = new Set(["call", "commands"]);

    expect(implemented.map((command) => command.path).toSorted()).toStrictEqual(
      shortcuts
        .flatMap((shortcut) => (routed.has(shortcut.path) ? [] : [shortcut.path]))
        .toSorted(),
    );
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

  it("refuses a blank --version offline instead of playing the default version", async () => {
    const runs = await Promise.all(
      ["", "   "].map((blank) => movies("play", "Alien", "--version", blank)),
    );

    for (const run of runs) {
      expect(run.code).toBe(ExitCode.usage);
      expect(run.stderr).toContain("--version expects a version name or its number");
    }
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
    const { home: other, path, stored } = storedHome();
    const overridden = { XDG_CONFIG_HOME: other, MOVIES_CONVEX_URL: "http://127.0.0.1:9" };
    // Nothing listens on the discard port: any request at all fails as unavailable (exit 9).
    const run = await runInProcess(["whoami"], overridden);
    const use = await runInProcess(["profiles", "use", "Kids"], overridden);
    const login = await runInProcess(["login", "--api-key", "mk_other"], overridden);
    const logout = await runInProcess(["logout"], overridden);
    const after = readFileSync(path, "utf8");

    rmSync(other, { recursive: true, force: true });
    expect(run.code).toBe(ExitCode.unauthenticated);
    expect(JSON.parse(run.stderr)).toMatchObject({ error: { code: "not_logged_in" } });

    for (const [name, refused] of Object.entries({ use, login, logout })) {
      expect(refused.code, name).toBe(ExitCode.usage);
      expect(refused.stderr, name).toContain("--profile <new-name>");
    }

    expect(after).toBe(stored);
  });

  it("logs out of an unreachable server by forgetting the stored session and key", async () => {
    const { home: offline, path } = storedHome("http://127.0.0.1:9");
    const run = await runInProcess(["logout"], { XDG_CONFIG_HOME: offline });
    const after = readFileSync(path, "utf8");

    rmSync(offline, { recursive: true, force: true });
    expect(run.code, run.stderr).toBe(ExitCode.ok);
    expect(JSON.parse(after)).toStrictEqual({
      defaultProfile: "home",
      profiles: { home: { convexUrl: "http://127.0.0.1:9", deviceId: "cli-home" } },
    });
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

/**
 * Runs `run` against a stand-in media service answering with `handler`, signed in from a stored
 * profile whose Convex URL is the discard port: nothing here may reach Convex.
 */
const withSignedInMedia = (
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  run: (signedIn: (...argv: ReadonlyArray<string>) => Promise<CliRun>) => Promise<void>,
) =>
  withMediaService(handler, async (mediaUrl) => {
    const { home: signedIn } = storedHome("http://127.0.0.1:9");

    try {
      await run((...argv) =>
        runInProcess(argv, { XDG_CONFIG_HOME: signedIn, MOVIES_MEDIA_URL: mediaUrl }),
      );
    } finally {
      rmSync(signedIn, { recursive: true, force: true });
    }
  });

/** Text a player could have put in a log record: C0 escape, DEL, and the C1 NEL and CSI. */
const hostile = "a\u001b[2Jb\u007fc\u0085d\u009be";

const hostileRecord = `${JSON.stringify({
  message: `Player.error ${hostile}`,
  level: "WARN",
  timestamp: "2026-10-21T20:01:02.123Z",
  annotations: { detail: hostile, [`key${hostile}`]: 1 },
  spans: {},
})}\n`;

const timeline = {
  sessionId: `session${hostile}`,
  firstSeenAt: Date.UTC(2026, 9, 21, 20),
  lastSeenAt: Date.UTC(2026, 9, 21, 20, 47),
  platform: "web",
  counts: {
    streams: 1,
    stalls: 0,
    stalledMs: 0,
    slowSegments: 0,
    failedRequests: 0,
    playerErrors: 1,
    recoveries: 0,
    slowFragments: 0,
    droppedFrames: 0,
  },
  drift: { status: "not-measured", reason: `No report ${hostile}` },
  missing: [`Gap ${hostile}`],
  truncated: false,
  entries: [
    {
      at: Date.UTC(2026, 9, 21, 20, 1),
      source: "player",
      kind: "player-error",
      level: "WARN",
      streamId: null,
      summary: `Player said ${hostile}`,
      details: { detail: hostile },
    },
  ],
};

const sessionList = [
  {
    sessionId: `session${hostile}`,
    userId: null,
    firstSeenAt: Date.UTC(2026, 9, 21, 20),
    lastSeenAt: Date.UTC(2026, 9, 21, 20, 47),
    platform: "web",
    warnings: 1,
  },
];

/** Answers the log route with `hostileRecord` and the diagnostics routes with the values above. */
const diagnosticsService = (request: IncomingMessage, response: ServerResponse) => {
  const body = { "/api/diagnostics/playback": timeline, "/api/diagnostics/sessions": sessionList };

  if (request.url === "/api/logs") {
    response.writeHead(200, { "content-type": "application/x-ndjson" });
    response.end(hostileRecord);
  } else if (
    request.url === "/api/diagnostics/playback" ||
    request.url === "/api/diagnostics/sessions"
  ) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body[request.url]));
  } else {
    response.writeHead(404).end();
  }
};

/** Whether `text` holds a control character other than the newlines between lines. */
const hasControl = (text: string): boolean => /\p{Cc}/u.test(text.replaceAll("\n", ""));

describe("troubleshooting commands", () => {
  it("refuses flags they cannot read before connecting", async () => {
    const since = await movies("logs", "--since", "whenever");
    const follow = await movies("logs", "--follow", "--until", "1h");
    const level = await movies("logs", "--level", "loud");

    expect(since.code).toBe(ExitCode.usage);
    expect(since.stderr).toContain("--since expects a duration");
    expect(follow.stderr).toContain("drop --until");
    expect(level.stderr).toContain("--level must be");
  });

  it("refuses a window that ends before or when it starts, before connecting", async () => {
    const runs = await Promise.all([
      movies("logs", "--since", "1m", "--until", "2m"),
      movies("logs", "--since", "2026-10-21T14:00:00Z", "--until", "2026-10-21T14:00:00Z"),
    ]);

    for (const run of runs) {
      expect(run.code).toBe(ExitCode.usage);
      expect(JSON.parse(run.stderr)).toMatchObject({ error: { code: "usage" } });
    }
  });

  it("prints no control character a player sent, in logs or a playback timeline", async () => {
    await withSignedInMedia(diagnosticsService, async (signedIn) => {
      const logs = await signedIn("logs");
      const playback = await signedIn("diagnostics", "playback", "s1", "--human");
      const sessions = await signedIn("diagnostics", "sessions", "--human");

      for (const [name, run] of Object.entries({ logs, playback, sessions })) {
        expect(run.code, `${name}: ${run.stderr}`).toBe(ExitCode.ok);
        expect(hasControl(run.stdout), name).toBe(false);
        expect(run.stdout, name).toContain(String.raw`a\u001b[2Jb\u007fc\u0085d\u009be`);
      }

      expect(logs.stdout).toContain(String.raw`detail="a\u001b[2Jb\u007fc\u0085d\u009be"`);
    });
  });

  it("takes --json and --human the same way in logs and diagnostics", async () => {
    await withSignedInMedia(diagnosticsService, async (signedIn) => {
      const logs = await signedIn("logs", "--json");
      const playback = await signedIn("diagnostics", "playback", "s1", "--json");
      const sessions = await signedIn("diagnostics", "sessions", "--json");

      expect(logs.stdout).toBe(hostileRecord.trim());
      expect(JSON.parse(playback.stdout)).toMatchObject({ sessionId: timeline.sessionId });
      expect(JSON.parse(sessions.stdout)).toMatchObject([{ warnings: 1 }]);

      const both = await Promise.all([
        signedIn("logs", "--json", "--human"),
        signedIn("diagnostics", "playback", "s1", "--json", "--human"),
        signedIn("diagnostics", "sessions", "--json", "--human"),
      ]);

      for (const run of both) expect(run.code, run.stderr).toBe(ExitCode.usage);
    });
  });

  it("fails as unavailable when the service ends a followed log", async () => {
    const ending = {
      "closes the response": (response: ServerResponse) => response.end(),
      "drops the connection": (response: ServerResponse) => response.socket?.destroy(),
    };

    await Promise.all(
      Object.entries(ending).map(([how, end]) =>
        withSignedInMedia(
          (_request, response) => {
            response.writeHead(200, { "content-type": "application/x-ndjson" });
            response.write(hostileRecord, () => setTimeout(() => end(response), 50));
          },
          async (signedIn) => {
            const run = await signedIn("logs", "--follow");

            expect(run.code, how).toBe(ExitCode.unavailable);
            expect(JSON.parse(run.stderr), how).toMatchObject({ error: { code: "unavailable" } });
            expect(run.stdout, how).toContain("Player.error");
          },
        ),
      ),
    );
  });

  it("asks for a session ID and says where to find one", async () => {
    const run = await movies("diagnostics", "playback");

    expect(run.code).toBe(ExitCode.usage);
    expect(run.stderr).toContain("movies diagnostics sessions");
  });
});
