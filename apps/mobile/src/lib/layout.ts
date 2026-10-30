/**
 * How much width the window gives the app: `compact` for an iPhone and narrow iPad windows such as
 * Slide Over, `regular` for an iPad in portrait or two-thirds of Split View, `wide` for an iPad in
 * landscape.
 */
export type WidthClass = "compact" | "regular" | "wide";

/** Where `regular` and `wide` start, in points. */
export interface WidthBreakpoints {
  readonly regular: number;
  readonly wide: number;
}

/** The class of a window `width` points wide. */
export const widthClassOf = (width: number, breakpoints: WidthBreakpoints): WidthClass => {
  if (width >= breakpoints.wide) return "wide";

  return width >= breakpoints.regular ? "regular" : "compact";
};
