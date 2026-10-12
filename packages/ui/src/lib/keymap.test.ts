import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  chordFromEvent,
  createKeymap,
  formatKeycaps,
  parseKeySequence,
  stepKeymap,
} from "./keymap";
import type { KeyChord, KeySequence, KeymapStep } from "./keymap";

const press = (
  key: string,
  modifiers: Partial<Record<"meta" | "ctrl" | "alt" | "shift", boolean>> = {},
): KeyChord =>
  chordFromEvent({
    key,
    metaKey: modifiers.meta ?? false,
    ctrlKey: modifiers.ctrl ?? false,
    altKey: modifiers.alt ?? false,
    shiftKey: modifiers.shift ?? false,
  });

const registry = [
  { id: "menu", keys: "mod+k", whileTyping: true },
  { id: "home", keys: "g h" },
  { id: "list", keys: "g l" },
  { id: "settings", keys: "g ," },
  { id: "profile", keys: "mod+shift+p" },
  { id: "search", keys: "/" },
  { id: "help", keys: "?" },
] as const;

/** Feed chords through the matcher the way the global listener does and collect the matches. */
const run = (
  keys: ReadonlyArray<KeyChord>,
  platform: "mac" | "other" = "mac",
): ReadonlyArray<string> => {
  const keymap = createKeymap(registry, platform);
  const matched: Array<string> = [];
  let prefix: KeySequence = [];

  for (const chord of keys) {
    const step: KeymapStep<(typeof registry)[number]["id"]> = stepKeymap(
      keymap.bindings,
      prefix,
      chord,
    );

    if (step.kind === "matched") matched.push(step.id);

    prefix = step.kind === "pending" ? step.prefix : [];
  }

  return matched;
};

describe("parseKeySequence", () => {
  it("resolves mod to meta on Apple devices and ctrl elsewhere", () => {
    expect(parseKeySequence("mod+k", "mac")).toEqual([
      { key: "k", meta: true, ctrl: false, alt: false, shift: false },
    ]);
    expect(parseKeySequence("mod+k", "other")).toEqual([
      { key: "k", meta: false, ctrl: true, alt: false, shift: false },
    ]);
  });

  it("splits sequences on whitespace and normalizes key names", () => {
    expect(parseKeySequence("  g   h ", "mac").map((chord) => chord.key)).toEqual(["g", "h"]);
    expect(parseKeySequence("Esc", "mac")[0]?.key).toBe("escape");
    expect(parseKeySequence("ctrl+Up", "mac")[0]).toMatchObject({ key: "arrowup", ctrl: true });
  });

  it("rejects malformed bindings", () => {
    expect(() => parseKeySequence("", "mac")).toThrow("empty");
    expect(() => parseKeySequence("mod+", "mac")).toThrow("no key");
    expect(() => parseKeySequence("hyper+k", "mac")).toThrow("unknown modifier");
  });
});

describe("stepKeymap", () => {
  it("matches single chords and two-key sequences", () => {
    expect(run([press("k", { meta: true })])).toEqual(["menu"]);
    expect(run([press("g"), press("h")])).toEqual(["home"]);
    expect(run([press("g"), press(",")])).toEqual(["settings"]);
  });

  it("uses ctrl for mod on other platforms", () => {
    expect(run([press("k", { ctrl: true })], "other")).toEqual(["menu"]);
    expect(run([press("k", { meta: true })], "other")).toEqual([]);
  });

  it("treats shift as part of letters but not of symbols", () => {
    expect(run([press("P", { meta: true, shift: true })])).toEqual(["profile"]);
    expect(run([press("p", { meta: true })])).toEqual([]);
    expect(run([press("?", { shift: true })])).toEqual(["help"]);
    expect(run([press("G", { shift: true }), press("h")])).toEqual([]);
  });

  it("restarts from a chord that breaks a pending sequence", () => {
    expect(run([press("g"), press("x"), press("g"), press("l")])).toEqual(["list"]);
    expect(run([press("g"), press("/")])).toEqual(["search"]);
  });

  it("ignores keys no binding starts with", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom("a", "b", "x", "1", "enter"), { maxLength: 12 }),
        (keys) => {
          expect(run(keys.map((key) => press(key)))).toEqual([]);
        },
      ),
    );
  });

  it("finds a sequence after any unrelated keys", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom("a", "x", "1", "enter", "g"), { maxLength: 8 }),
        (noise) => {
          const matched = run([...noise.map((key) => press(key)), press("g"), press("h")]);

          expect(matched.at(-1)).toBe("home");
        },
      ),
    );
  });
});

describe("formatKeycaps", () => {
  it("draws keycaps the way the command menu shows them", () => {
    const mac = createKeymap(registry, "mac");
    const other = createKeymap(registry, "other");

    expect(mac.keycaps("home")).toEqual(["G", "H"]);
    expect(mac.keycaps("settings")).toEqual(["G", ","]);
    expect(mac.keycaps("profile")).toEqual(["⌘", "⇧", "P"]);
    expect(other.keycaps("profile")).toEqual(["Ctrl", "Shift", "P"]);
    expect(formatKeycaps(parseKeySequence("mod+enter", "mac"), "mac")).toEqual(["⌘", "↵"]);
    expect(formatKeycaps(parseKeySequence("backspace", "mac"), "mac")).toEqual(["⌫"]);
  });
});

describe("createKeymap", () => {
  it("rejects duplicate ids and shadowed sequences", () => {
    expect(() =>
      createKeymap(
        [
          { id: "a", keys: "g h" },
          { id: "a", keys: "g l" },
        ],
        "mac",
      ),
    ).toThrow("twice");
    expect(() =>
      createKeymap(
        [
          { id: "go", keys: "g" },
          { id: "home", keys: "g h" },
        ],
        "mac",
      ),
    ).toThrow("prefix");
  });
});
