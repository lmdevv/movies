/**
 * Lucide glyphs (2pt strokes, as Paper draws them) in a text color role. Transport glyphs such as
 * play and pause are drawn filled.
 */
import type { LucideIcon } from "lucide-react-native";

import { useThemeColor } from "@/lib/theme-color";

import type { TextTone } from "./text";

const TONE_VARIABLES = {
  default: "--color-text",
  muted: "--color-text-muted",
  accent: "--color-accent",
  danger: "--color-danger",
  success: "--color-success",
  onAccent: "--color-on-accent",
  onMedia: "--color-dark-text",
  onMediaMuted: "--color-video-muted",
} as const satisfies Record<TextTone, string>;

/** Props for `Icon`. */
export interface IconProps {
  readonly icon: LucideIcon;
  readonly tone?: TextTone;
  readonly size?: number;
  readonly filled?: boolean;
}

/** A Lucide glyph colored by role. */
export function Icon({ icon: Glyph, tone = "default", size = 24, filled = false }: IconProps) {
  const color = useThemeColor(TONE_VARIABLES[tone]);

  return (
    <Glyph
      size={size}
      strokeWidth={2}
      color={color}
      fill={filled ? color : "none"}
      accessibilityElementsHidden
      importantForAccessibility="no"
    />
  );
}
