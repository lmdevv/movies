import { resolve } from "node:path";

import { generateFixtureLibrary } from "../src/testing/fixture-library.ts";

const target = resolve(process.argv[2] ?? "fixtures");

const library = await generateFixtureLibrary(target);

process.stdout.write(
  `${JSON.stringify({ moviesRoot: library.moviesRoot, showsRoot: library.showsRoot }, undefined, 2)}\n`,
);
