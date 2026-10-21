/**
 * The built `movies` binary as a separate process, for behaviour that depends on the process
 * itself, such as reading stdin. No server needed.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ExitCode } from "./cli-errors";
import { withMediaService } from "./testing/media-service";
import { buildCli, makeTempDir, removeDir, runMovies, startMovies } from "./testing/process";

let home = "";

beforeAll(async () => {
  buildCli();
  home = await makeTempDir("movies-cli-binary-");
}, 60_000);

afterAll(() => removeDir(home));

describe("the movies binary", () => {
  it("rejects an empty secret on stdin before connecting", async () => {
    const env = { XDG_CONFIG_HOME: home, HOME: home };

    const runs = await Promise.all([
      runMovies(["import", "jellyfin", "--url", "http://127.0.0.1:9"], env, " \n"),
      runMovies(
        ["login", "--server", "http://127.0.0.1:9", "--email", "a@example.com", "--password"],
        env,
        " \n",
      ),
    ]);

    for (const run of runs) {
      expect(run.code, run.stderr).toBe(ExitCode.usage);
      expect(run.stderr).toContain("on stdin is empty");
    }
  });

  it("rejects a secret variable that is set but empty, without reading stdin", async () => {
    const env = { XDG_CONFIG_HOME: home, HOME: home };

    // stdin holds a secret, so reading it would get past the check and on to the server.
    const runs = await Promise.all([
      runMovies(
        ["import", "jellyfin", "--url", "http://127.0.0.1:9"],
        { ...env, MOVIES_IMPORT_TOKEN: "" },
        "token\n",
      ),
      runMovies(
        ["login", "--server", "http://127.0.0.1:9", "--email", "a@example.com", "--password"],
        { ...env, MOVIES_PASSWORD: " " },
        "password\n",
      ),
    ]);

    for (const run of runs) {
      expect(run.code, run.stderr).toBe(ExitCode.usage);
      expect(run.stderr).toContain("is set but empty");
    }
  });

  it("ends quietly when the reader of its output stops early, as `movies logs | head` does", async () => {
    const signedIn = join(home, "signed-in");

    const record = `${JSON.stringify({
      message: "Stream.started",
      level: "INFO",
      timestamp: "2026-10-21T20:01:02.123Z",
      annotations: {},
    })}\n`;

    mkdirSync(join(signedIn, "movies"), { recursive: true });
    writeFileSync(
      join(signedIn, "movies", "config.json"),
      JSON.stringify({
        defaultProfile: "home",
        profiles: {
          home: {
            convexUrl: "http://127.0.0.1:9",
            deviceId: "cli-home",
            apiKey: "mk_home",
            session: { token: "jwt-home", refreshToken: "refresh-home" },
          },
        },
      }),
    );

    const run = await withMediaService(
      (_request, response) => {
        response.writeHead(200, { "content-type": "application/x-ndjson" });
        response.end(record.repeat(5000));
      },
      (mediaUrl) => {
        const running = startMovies(["logs", "--json", "--limit", "5000"], {
          XDG_CONFIG_HOME: signedIn,
          HOME: signedIn,
          MOVIES_MEDIA_URL: mediaUrl,
        });

        running.child.stdout.once("data", () => running.child.stdout.destroy());

        return running.done;
      },
    );

    expect(run.stderr).not.toContain("EPIPE");
    expect(run.code, run.stderr).toBe(ExitCode.ok);
  });
});
