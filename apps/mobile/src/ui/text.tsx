/** Text in one of the iOS page's treatments, in the theme's text color unless told otherwise. */
import { Text as NativeText } from "react-native";
import type { TextProps as NativeTextProps } from "react-native";

import { colors, type } from "@/theme/tokens";
import type { TypeVariant } from "@/theme/tokens";

/** Props for `Text`. */
export interface TextProps extends NativeTextProps {
  readonly variant: TypeVariant;
  /** A theme color; the text color when omitted. */
  readonly color?: string;
}

/** Text in a type treatment from `tokens.type`. */
export function Text({ variant, color = colors.text, style, ...props }: TextProps) {
  const treatment = type[variant];

  return (
    <NativeText
      {...props}
      style={[
        {
          color,
          fontFamily: treatment.family,
          fontSize: treatment.size,
          lineHeight: treatment.lineHeight,
          letterSpacing: treatment.tracking * treatment.size,
          textTransform: "uppercase" in treatment ? "uppercase" : "none",
        },
        style,
      ]}
    />
  );
}
