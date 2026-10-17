/** Theme colors as strings, for native props that take a color rather than a class. */
import { useCSSVariable } from "uniwind";

/** A color role from the theme, such as `--color-accent`, following the current theme. */
export const useThemeColor = (variable: `--color-${string}`): string => {
  const value = useCSSVariable(variable);

  return value === undefined ? "transparent" : String(value);
};

/** Several color roles at once, such as a gradient's stops, following the current theme. */
export const useThemeColors = (
  variables: ReadonlyArray<`--color-${string}`>,
): ReadonlyArray<string> => {
  const values = useCSSVariable([...variables]);

  return values.map((value) => (value === undefined ? "transparent" : String(value)));
};
