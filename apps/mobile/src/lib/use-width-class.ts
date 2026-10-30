import { useWindowDimensions } from "react-native";
import { useCSSVariable } from "uniwind";

import { widthClassOf } from "./layout";
import type { WidthClass } from "./layout";

/**
 * The window's class, from the `--breakpoint-*` tokens behind the `regular:` and `wide:` class
 * variants, so code and classes switch at the same width.
 */
export const useWidthClass = (): WidthClass => {
  const { width } = useWindowDimensions();
  const [regular, wide] = useCSSVariable(["--breakpoint-regular", "--breakpoint-wide"]);

  return widthClassOf(width, {
    regular: Number.parseFloat(String(regular)),
    wide: Number.parseFloat(String(wide)),
  });
};
