/**
 * Bundles the CLI into one executable file, `dist/movies.js`, so it installs and runs without the
 * workspace, with the licenses of the packages it inlines in `dist/THIRD_PARTY_LICENSES.md`.
 * `--watch` rebuilds on change.
 */
import { chmod } from "node:fs/promises";
import { join } from "node:path";

import type { BuildOptions } from "esbuild";
import { build, context } from "esbuild";

import { writeThirdPartyLicenses } from "./licenses.ts";

const root = join(import.meta.dirname, "..");

const outfile = join(root, "dist", "movies.js");

const options: BuildOptions = {
  entryPoints: [join(root, "src", "main.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: { js: "#!/usr/bin/env node" },
  legalComments: "none",
  logLevel: "warning",
};

if (process.argv.includes("--watch")) {
  const watcher = await context(options);

  await watcher.watch();
} else {
  const { metafile } = await build({ ...options, metafile: true });

  await chmod(outfile, 0o755);

  await writeThirdPartyLicenses(metafile, join(root, "dist", "THIRD_PARTY_LICENSES.md"));
}
