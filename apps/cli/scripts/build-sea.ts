/**
 * Builds the standalone `movies` executable for this machine's OS and CPU, a Node single executable
 * application: a copy of the running `node` with the CLI injected, so it runs without Node
 * installed. Writes `dist/sea/movies-<os>-<arch>` (such as `movies-linux-x64`) and signs it ad hoc
 * on macOS, which Apple silicon requires. The release workflow runs it on each target's runner.
 *
 *   node scripts/build-sea.ts
 */
import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { build } from "esbuild";

const root = join(import.meta.dirname, "..");

const out = join(root, "dist", "sea");

const main = join(out, "movies.cjs");

const blob = join(out, "movies.blob");

const config = join(out, "sea-config.json");

const executable = join(out, `movies-${process.platform}-${process.arch}`);

const darwin = process.platform === "darwin";

const run = (command: string, args: ReadonlyArray<string>): void => {
  execFileSync(command, args, { stdio: "inherit" });
};

await rm(out, { recursive: true, force: true });

await mkdir(out, { recursive: true });

// Node 24 runs a single executable's entry point as CommonJS only.
await build({
  entryPoints: [join(root, "src", "main.ts")],
  outfile: main,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: `node${process.versions.node}`,
  legalComments: "none",
  logLevel: "warning",
});

await writeFile(
  config,
  JSON.stringify({ main, output: blob, disableExperimentalSEAWarning: true }),
);

run(process.execPath, ["--experimental-sea-config", config]);

await copyFile(process.execPath, executable);

await chmod(executable, 0o755);

if (darwin) run("codesign", ["--remove-signature", executable]);

run("npx", [
  "--yes",
  "postject@1.0.0-alpha.6",
  executable,
  "NODE_SEA_BLOB",
  blob,
  "--sentinel-fuse",
  "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  ...(darwin ? ["--macho-segment-name", "NODE_SEA"] : []),
]);

if (darwin) run("codesign", ["--sign", "-", executable]);
