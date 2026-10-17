/**
 * Text in the iOS type scale from Paper's foundations board (`01 · iOS Foundations & Components`):
 * Inter Tight at 34/40 for large titles, 22/28 for section headings, 17/23 for body, 15/21 for
 * labels and 13/19 for metadata. Each weight is its own font file, so weight lives in the variant.
 */
import type { ReactNode } from "react";
import { Text as NativeText } from "react-native";
import type { TextProps as NativeTextProps } from "react-native";

const VARIANTS = {
  /** Avatar initials and hero title fallbacks: 56/56 heavy. */
  hero: "font-sans-heavy text-display leading-display tracking-display",
  /** Welcome headlines and title art fallbacks: 40/46 bold, display tracking. */
  display: "font-sans-bold text-ios-40 leading-ios-46 tracking-display",
  /** The featured title over Home's hero (C01): 48/54 bold, display tracking. */
  heroTitle: "font-sans-bold text-ios-48 leading-ios-54 tracking-display",
  /** Large screen titles: 34/40 bold. */
  largeTitle: "font-sans-bold text-ios-34 leading-ios-40 tracking-display",
  /**
   * Titles inside a screen: File unavailable, About, calm states, invites, collection names, and
   * empty-state headings: 28/34 bold.
   */
  title: "font-sans-bold text-ios-28 leading-ios-34",
  /** Navigation titles beside a back button: 20/26 semibold. */
  navTitle: "font-sans-semibold text-heading leading-heading",
  /** Keypad digits: 28/34 medium. */
  keypad: "font-sans-medium text-ios-28 leading-ios-34",
  /** Profile names beside their tiles and short prompts: 22/28 semibold. */
  subheading: "font-sans-semibold text-ios-22 leading-ios-28",
  /** Section headings such as Continue Watching: 22/28 bold. */
  heading: "font-sans-bold text-ios-22 leading-ios-28",
  /** Body copy and row titles: 17/23 regular. */
  body: "font-sans text-ios-17 leading-ios-23",
  /** Names under profile tiles in sheets: 17/23 medium. */
  bodyMedium: "font-sans-medium text-ios-17 leading-ios-23",
  /** Button labels and emphasized rows: 17/23 semibold. */
  bodyStrong: "font-sans-semibold text-ios-17 leading-ios-23",
  /** Field labels and secondary row text: 15/21 medium. */
  label: "font-sans-medium text-body leading-ios-21",
  /** Secondary row text such as a row's detail: 15/21 regular. */
  secondary: "font-sans text-body leading-ios-21",
  /** Episode and card titles: 15/21 semibold. */
  labelStrong: "font-sans-semibold text-body leading-ios-21",
  /** Metadata such as `2024 · 2h 46m`: 13/19 regular. */
  meta: "font-sans text-label leading-ios-19",
  /** Emphasized metadata: 13/19 medium. */
  metaStrong: "font-sans-medium text-label leading-ios-19",
  /** Captions and badges: 12/16 medium. */
  caption: "font-sans-medium text-caption leading-caption",
  /** Timecodes, codecs, paths, and keys: Geist Mono 13/19. */
  mono: "font-mono text-label leading-ios-19",
} as const;

const TONES = {
  default: "text-text",
  muted: "text-text-muted",
  accent: "text-accent",
  danger: "text-danger",
  success: "text-success",
  onAccent: "text-on-accent",
  /** White over artwork and video, whatever the theme. */
  onMedia: "text-dark-text",
  /** Secondary white over artwork and video. */
  onMediaMuted: "text-video-muted",
  /** The page color on a text-colored fill, such as a selected chip. */
  inverse: "text-bg",
} as const;

/** A step of the type scale. */
type TextVariant = keyof typeof VARIANTS;

/** A text color role. */
export type TextTone = keyof typeof TONES;

/** Props for `Text`. */
export interface TextProps extends Omit<NativeTextProps, "children"> {
  readonly variant?: TextVariant;
  readonly tone?: TextTone;
  readonly children?: ReactNode;
}

/** Text in the app's type scale and color roles. Extra classes may set layout, not type or color. */
export function Text({ variant = "body", tone = "default", className, ...props }: TextProps) {
  return (
    <NativeText
      className={`${VARIANTS[variant]} ${TONES[tone]} ${className ?? ""}`}
      maxFontSizeMultiplier={1.6}
      {...props}
    />
  );
}
