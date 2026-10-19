/** The native form sheet the app's stacks present, sized to its content, in the theme's colors. */
import { useCSSVariable } from "uniwind";

import { useThemeColor } from "./theme-color";

/**
 * Screen options for a native form sheet: the grabber, the height of its content, the
 * `--radius-sheet` corners, and the raised surface behind it.
 */
export const useSheetOptions = () => {
  const surface = useThemeColor("--color-surface-raised");
  // Native sheets take the radius in points; the token is `28px`.
  const radius = Number.parseFloat(String(useCSSVariable("--radius-sheet")));

  return {
    presentation: "formSheet",
    sheetAllowedDetents: "fitToContents",
    sheetGrabberVisible: true,
    sheetCornerRadius: radius,
    contentStyle: { backgroundColor: surface },
  } as const;
};
