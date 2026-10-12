/**
 * Points a packaged web build at its Convex deployment. The image and the Nix package build the
 * web app once with `VITE_CONVEX_URL=__MOVIES_CONVEX_URL__`; at startup this copies the build and
 * writes the real URL into it, so one build serves any install.
 *
 *   node scripts/configure-web.ts --from /app/web --to /run/movies/web --convex-url http://nas:3210
 *
 * Every asset holding the placeholder gets a new name derived from the URL, and every reference to
 * it is rewritten, so a browser never keeps a cached asset (served `immutable`) that points at a
 * previous URL. Plain Node, no Effect: it runs before the service starts.
 */
import { createHash } from "node:crypto";
import { cp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";
import { parseArgs } from "node:util";

/** What `VITE_CONVEX_URL` holds in a packaged build. */
const PLACEHOLDER = "__MOVIES_CONVEX_URL__";

/** Files whose text may name an asset or hold the placeholder. */
const TEXT = new Set([".html", ".js", ".mjs", ".css", ".json", ".webmanifest", ".map"]);

const { values } = parseArgs({
  options: {
    from: { type: "string" },
    to: { type: "string" },
    "convex-url": { type: "string" },
  },
});

const { from, to, "convex-url": convexUrl } = values;

if (from === undefined || to === undefined || convexUrl === undefined) {
  process.stderr.write("usage: configure-web.ts --from <dist> --to <dir> --convex-url <url>\n");
  process.exit(2);
}

const url = new URL(convexUrl);

if (url.protocol !== "http:" && url.protocol !== "https:") {
  process.stderr.write(`configure-web: ${convexUrl} is not an http(s) URL\n`);
  process.exit(2);
}

// The placeholder sits inside a JavaScript string literal; JSON escaping keeps the URL inside it.
const literal = JSON.stringify(convexUrl).slice(1, -1);

const suffix = createHash("sha256").update(convexUrl).digest("hex").slice(0, 8);

const listFiles = async (directory: string): Promise<ReadonlyArray<string>> => {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });

  return entries
    .filter((entry) => entry.isFile() && TEXT.has(extname(entry.name)))
    .map((entry) => join(entry.parentPath, entry.name));
};

await rm(to, { recursive: true, force: true });

await cp(from, to, { recursive: true });

const files = await listFiles(to);

const contents = new Map(
  await Promise.all(files.map(async (file) => [file, await readFile(file, "utf8")] as const)),
);

const renames = new Map<string, string>();

for (const [file, text] of contents) {
  if (!text.includes(PLACEHOLDER)) continue;

  const extension = extname(file);
  const renamed = join(dirname(file), `${basename(file, extension)}-${suffix}${extension}`);

  contents.set(file, text.replaceAll(PLACEHOLDER, literal));
  renames.set(file, renamed);
}

if (renames.size === 0) {
  process.stderr.write(`configure-web: no file in ${from} holds ${PLACEHOLDER}\n`);
  process.exit(1);
}

// Asset names are content hashes, unique enough to rewrite as plain text everywhere.
const replacements = [...renames].map(
  ([file, renamed]) => [basename(file), basename(renamed)] as const,
);

await Promise.all(
  [...contents].map(async ([file, text]) => {
    const rewritten = replacements.reduce(
      (next, [old, renamed]) => next.replaceAll(old, renamed),
      text,
    );

    await writeFile(file, rewritten);
  }),
);

await Promise.all([...renames].map(([file, renamed]) => rename(file, renamed)));

process.stderr.write(
  `configure-web: ${[...renames.values()].map((file) => relative(to, file)).join(", ")} use ${convexUrl}\n`,
);
