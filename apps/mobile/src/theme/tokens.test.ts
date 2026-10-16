import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { PAPER, colors, lightColors } from "./tokens";

/** The web theme, which holds the same Paper tokens under the same names. */
const css = readFileSync(
  new URL("../../../../packages/ui/src/styles/globals.css", import.meta.url),
  "utf8",
);

const theme = /@theme \{([^}]*)\}/u.exec(css)?.[1] ?? "";

const webTokens = new Map(
  [...theme.matchAll(/(--[\w-]+):\s*([^;]+);/gu)].map((match) => [
    match[1],
    (match[2] ?? "").trim().toLowerCase(),
  ]),
);

describe("design tokens", () => {
  it("reads the web theme", () => {
    expect(webTokens.get("--color-accent")).toBe("#e50914");
  });

  it("matches every shared Paper token in the web theme", () => {
    const drifted = Object.entries(PAPER).flatMap(([name, value]) =>
      webTokens.get(name) === value.toLowerCase()
        ? []
        : [`${name}: app ${value}, web ${webTokens.get(name) ?? "missing"}`],
    );

    expect(drifted).toStrictEqual([]);
  });

  it("keeps a light twin for every dark role", () => {
    expect(Object.keys(lightColors).toSorted()).toStrictEqual(Object.keys(colors).toSorted());
    expect(lightColors.bg).toBe(PAPER["--color-bg"]);
    expect(colors.bg).toBe(PAPER["--color-dark-bg"]);
  });
});
