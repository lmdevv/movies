/**
 * Design tokens from the [movies] Paper file (`01M4PMRM5T60Q4P0YYZ8DY580D`), page 13 iOS app.
 * `PAPER` holds the tokens the web theme shares under their Paper names; `tokens.test.ts` fails
 * when one drifts from `packages/ui/src/styles/globals.css`. The roles below read from it. The iOS
 * page also draws literal values that are not Paper tokens yet (system fills, the glass recipe,
 * radii of fields and art); they live here, named by role, so components never hold raw values.
 */

/** Paper tokens shared with the web theme, by their CSS variable names. */
export const PAPER = {
  "--color-bg": "#ffffff",
  "--color-surface": "#f2f2f7",
  "--color-surface-raised": "#ffffff",
  "--color-hairline": "#e5e5ea",
  "--color-text": "#111111",
  "--color-text-muted": "#636366",
  "--color-dark-bg": "#000000",
  "--color-dark-surface": "#141414",
  "--color-dark-surface-raised": "#232323",
  "--color-dark-hairline": "#2f2f2f",
  "--color-dark-text": "#ffffff",
  "--color-dark-text-muted": "#a3a3a3",
  "--color-accent": "#e50914",
  "--color-accent-pressed": "#b20710",
  "--color-on-accent": "#ffffff",
  "--color-success": "#1e9e4a",
  "--color-warning": "#b76e00",
  "--color-dark-success": "#46d369",
  "--color-dark-warning": "#f5a623",
  "--color-scrim": "rgb(0 0 0 / 60%)",
  "--color-danger": "#d70f1a",
  "--color-dark-danger": "#ff6b6b",
  "--text-caption": "12px",
  "--text-label": "13px",
  "--text-body": "15px",
  "--text-heading": "20px",
  "--leading-caption": "16px",
  "--leading-label": "18px",
  "--leading-body": "22px",
  "--opacity-muted": "60%",
  "--opacity-disabled": "40%",
  "--spacing-1": "4px",
  "--spacing-2": "8px",
  "--spacing-3": "12px",
  "--spacing-4": "16px",
  "--spacing-6": "24px",
  "--spacing-8": "32px",
  "--spacing-10": "40px",
  "--spacing-12": "48px",
  "--spacing-16": "64px",
  "--radius-poster": "4px",
  "--radius-control": "8px",
  "--radius-card": "14px",
  "--radius-pill": "999px",
} as const;

/** Color roles of one theme. */
interface Palette {
  readonly bg: string;
  readonly surface: string;
  readonly surfaceRaised: string;
  readonly hairline: string;
  readonly text: string;
  readonly textMuted: string;
  readonly accent: string;
  readonly accentPressed: string;
  readonly onAccent: string;
  readonly success: string;
  readonly warning: string;
  readonly danger: string;
  readonly scrim: string;
}

const shared = {
  accent: PAPER["--color-accent"],
  accentPressed: PAPER["--color-accent-pressed"],
  onAccent: PAPER["--color-on-accent"],
  scrim: "rgba(0, 0, 0, 0.6)",
} as const;

/** The dark theme, the app's default: Paper's `--color-dark-*` roles. */
export const colors: Palette = {
  ...shared,
  bg: PAPER["--color-dark-bg"],
  surface: PAPER["--color-dark-surface"],
  surfaceRaised: PAPER["--color-dark-surface-raised"],
  hairline: PAPER["--color-dark-hairline"],
  text: PAPER["--color-dark-text"],
  textMuted: PAPER["--color-dark-text-muted"],
  success: PAPER["--color-dark-success"],
  warning: PAPER["--color-dark-warning"],
  danger: PAPER["--color-dark-danger"],
};

/** The light twins, for a later light theme. */
export const lightColors: Palette = {
  ...shared,
  bg: PAPER["--color-bg"],
  surface: PAPER["--color-surface"],
  surfaceRaised: PAPER["--color-surface-raised"],
  hairline: PAPER["--color-hairline"],
  text: PAPER["--color-text"],
  textMuted: PAPER["--color-text-muted"],
  success: PAPER["--color-success"],
  warning: PAPER["--color-warning"],
  danger: PAPER["--color-danger"],
};

/**
 * iOS system colors the iOS page draws: grouped rows and fields, raised controls inside them,
 * placeholders, glyphs, chevrons, and separators.
 */
export const system = {
  fill: "#1C1C1E",
  fillRaised: "#2C2C2E",
  placeholder: "#6C6C70",
  glyph: "#8E8E93",
  chevron: "#636366",
  separator: "rgba(255, 255, 255, 0.1)",
} as const;

/** White at the strengths the iOS page uses over art: facts, pills, dots, and tracks. */
export const overlay = {
  facts: "rgba(255, 255, 255, 0.75)",
  pill: "rgba(255, 255, 255, 0.16)",
  button: "rgba(255, 255, 255, 0.18)",
  buttonBorder: "rgba(255, 255, 255, 0.14)",
  dot: "rgba(255, 255, 255, 0.35)",
  track: "rgba(255, 255, 255, 0.25)",
  /** The circle behind a calm state's glyph. */
  well: "rgba(255, 255, 255, 0.08)",
  dangerFill: "rgba(255, 107, 107, 0.1)",
  dangerBorder: "rgba(255, 107, 107, 0.55)",
} as const;

/** The page's black at `alpha`, for scrims that fade art into the page. */
export const black = (alpha: number): string => `rgba(0, 0, 0, ${String(alpha)})`;

/**
 * Liquid glass as the iOS page draws it where the system material is unavailable: a translucent
 * fill over a 24px blur, a hairline border, a top highlight, and a soft drop shadow.
 */
export const glass = {
  fill: "rgba(44, 44, 46, 0.62)",
  bar: "rgba(22, 22, 24, 0.66)",
  border: "rgba(255, 255, 255, 0.1)",
  barBorder: "rgba(255, 255, 255, 0.08)",
  highlight: "rgba(255, 255, 255, 0.14)",
  selected: "rgba(255, 255, 255, 0.16)",
  selectedHighlight: "rgba(255, 255, 255, 0.18)",
  shadow: "rgba(0, 0, 0, 0.45)",
  /** The handle at the top of a sheet. */
  grabber: "rgba(255, 255, 255, 0.3)",
  secondaryFill: "rgba(255, 255, 255, 0.14)",
  secondaryBorder: "rgba(255, 255, 255, 0.12)",
} as const;

const px = (value: `${number}px`): number => Number.parseFloat(value);

const percent = (value: `${number}%`): number => Number.parseFloat(value) / 100;

/** Paper's opacities, and the dim of a pressed control. */
export const opacity = {
  muted: percent(PAPER["--opacity-muted"]),
  disabled: percent(PAPER["--opacity-disabled"]),
  pressed: 0.7,
} as const;

/** Paper's spacing scale; steps are multiples of 4px. */
export const space = {
  1: px(PAPER["--spacing-1"]),
  2: px(PAPER["--spacing-2"]),
  3: px(PAPER["--spacing-3"]),
  4: px(PAPER["--spacing-4"]),
  6: px(PAPER["--spacing-6"]),
  8: px(PAPER["--spacing-8"]),
  10: px(PAPER["--spacing-10"]),
  12: px(PAPER["--spacing-12"]),
  16: px(PAPER["--spacing-16"]),
} as const;

/** Side padding of every phone page. */
export const PAGE_INSET = 20;

/** Corner radii: Paper's tokens, then the iOS page's fields, art, and avatar tiles. */
export const radius = {
  poster: px(PAPER["--radius-poster"]),
  control: px(PAPER["--radius-control"]),
  card: px(PAPER["--radius-card"]),
  pill: px(PAPER["--radius-pill"]),
  field: 12,
  art: 10,
  tile: 18,
} as const;

/** Font families by weight, as `fonts.ts` registers them. */
export const fontFamily = {
  regular: "InterTight_400Regular",
  medium: "InterTight_500Medium",
  semibold: "InterTight_600SemiBold",
  bold: "InterTight_700Bold",
  heavy: "InterTight_800ExtraBold",
  black: "InterTight_900Black",
  mono: "GeistMono_400Regular",
} as const;

/** A weight of the sans family. */
type FontWeight = Exclude<keyof typeof fontFamily, "mono">;

/** One text treatment: size and line height in points, letter spacing in em. */
export interface TypeStyle {
  readonly family: (typeof fontFamily)[keyof typeof fontFamily];
  readonly size: number;
  readonly lineHeight: number;
  readonly tracking: number;
  readonly uppercase?: boolean;
}

const style = (
  weight: FontWeight | "mono",
  size: number,
  lineHeight: number,
  tracking = 0,
): TypeStyle => ({ family: fontFamily[weight], size, lineHeight, tracking });

/** The iOS page's type scale. */
export const type = {
  /** Screen titles such as `For Alex` and `Welcome back.` */
  largeTitle: style("heavy", 34, 40, -0.02),
  /** The heaviest display face, such as the `kids` avatar lettering. */
  display: style("black", 56, 50, -0.045),
  /** The billboard title, such as `DUNE`. */
  billboard: { ...style("black", 56, 50, -0.045), uppercase: true },
  /** The billboard's subtitle, such as `PART TWO`. */
  subtitleCaps: { ...style("heavy", 13, 16, 0.32), uppercase: true },
  /** The `[movies]` wordmark over sign-in screens. */
  brand: style("black", 26, 30, -0.04),
  /** The wordmark over Who's watching. */
  brandSmall: style("black", 22, 28, -0.04),
  /** Row headers such as `Continue watching`. */
  section: style("bold", 20, 24),
  /** Compact bar titles. */
  barTitle: style("semibold", 17, 22),
  /** Primary button labels. */
  button: style("bold", 17, 22),
  /** Secondary button labels. */
  buttonSecondary: style("semibold", 17, 22),
  body: style("regular", 15, 22),
  /** List row titles and profile names. */
  bodyStrong: style("semibold", 15, 20),
  /** Field labels and card titles. */
  label: style("semibold", 13, 18),
  /** Facts over art and error lines. */
  labelMedium: style("medium", 13, 18),
  caption: style("regular", 12, 16),
  /** Counts over art, such as `2 titles`. */
  captionMedium: style("medium", 12, 16),
  /** The title of a calm empty or failure state. */
  stateTitle: style("heavy", 24, 28, -0.02),
  /** The `NEW THIS WEEK` pill. */
  eyebrow: { ...style("bold", 12, 16, 0.08), uppercase: true },
  /** The `New` badge on posters. */
  badge: style("bold", 12, 16),
  /** Titles drawn over landscape cards. */
  cardTitle: { ...style("black", 18, 20, -0.03), uppercase: true },
  /** Titles drawn over posters. */
  posterTitle: { ...style("black", 15, 15, -0.03), uppercase: true },
  /** Collection names over art. */
  collectionTitle: style("heavy", 20, 24, -0.02),
  /** Tab bar labels, the only text under 12pt. */
  tab: style("medium", 10, 12),
  tabSelected: style("semibold", 10, 12),
  /** Server addresses, paths, and codes. */
  mono: style("mono", 15, 22),
  monoLabel: style("mono", 13, 18),
  monoCaption: style("mono", 12, 16),
} as const satisfies Readonly<Record<string, TypeStyle>>;

/** A text treatment's name. */
export type TypeVariant = keyof typeof type;
