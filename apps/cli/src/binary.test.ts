/**
 * The built `movies` binary as a separate process, for behaviour that depends on the process
 * itself, such as reading stdin. No server needed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ExitCode } from "./cli-errors";
import { buildCli, makeTempDir, removeDir, runMovies } from "./testing/process";

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
});
