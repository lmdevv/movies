/**
 * The licenses of the third-party packages a CLI bundle inlines, which every copy of the bundle
 * ships beside it: each package's name, version, license, and LICENSE and NOTICE files, found from
 * esbuild's metafile.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { Metafile } from "esbuild";

import { decodePackageManifest } from "./package-manifest.ts";

const LICENSE_FILE = /^(?:licen[cs]e|notice|copying)/iu;

/** `…/node_modules/@scope/name/dist/x.js` → `…/node_modules/@scope/name`. */
const packageDirectory = (input: string): string | undefined =>
  /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//u.exec(input)?.[1];

const section = async (directory: string): Promise<string> => {
  const manifest = decodePackageManifest(await readFile(join(directory, "package.json"), "utf8"));

  const files = (await readdir(directory)).filter((name) => LICENSE_FILE.test(name)).toSorted();

  const texts = await Promise.all(files.map((name) => readFile(join(directory, name), "utf8")));

  const body =
    texts.length > 0 ? texts.map((license) => license.trim()).join("\n\n") : "No license file.";

  return `## ${manifest.name} ${manifest.version} (${manifest.license ?? "no license field"})\n\n${body}\n`;
};

/** Writes the licenses of every package `metafile`'s inputs come from to `outfile`. */
export const writeThirdPartyLicenses = async (
  metafile: Metafile,
  outfile: string,
): Promise<void> => {
  const directories = new Set(
    Object.keys(metafile.inputs).flatMap((input) => {
      const directory = packageDirectory(input);

      return directory === undefined ? [] : [resolve(directory)];
    }),
  );

  const sections = await Promise.all([...directories].toSorted().map(section));

  await writeFile(
    outfile,
    `# Third-party licenses\n\nThe \`movies\` CLI bundles these packages.\n\n${sections.join("\n")}`,
  );
};
