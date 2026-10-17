/**
 * Light, dark, or following the system. Dark is the default theme, as in Paper; the choice is
 * kept on this device and applied before the first frame.
 */
import { Schema, Option } from "effect";
import { Uniwind } from "uniwind";

import { readValue } from "./secure-storage";

const KEY = "movies.appearance";

/** A theme choice. */
const Appearance = Schema.Literals(["dark", "light", "system"]);

const decodeAppearance = Schema.decodeUnknownOption(Appearance);

/** The theme this device chose; dark when none. */
const loadAppearance = (): typeof Appearance.Type =>
  Option.getOrElse(decodeAppearance(readValue(KEY)), () => "dark" as const);

/** Applies the remembered theme; call once at startup. */
export const applyAppearance = (): void => {
  Uniwind.setTheme(loadAppearance());
};
