/**
 * Round 44pt icon buttons. `raised` is the back button on plain screens (A02), `glass` sits over
 * artwork and video (D01, F01) with the system's glass material where iOS has it.
 */
import { BlurView } from "expo-blur";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import type { LucideIcon } from "lucide-react-native";
import { Pressable, StyleSheet, View } from "react-native";
import type { PressableProps } from "react-native";

import { Icon } from "./icon";

/** Props for `IconButton`. */
export interface IconButtonProps extends Omit<PressableProps, "children" | "style"> {
  readonly icon: LucideIcon;
  /** What VoiceOver reads, such as `Back`. */
  readonly label: string;
  readonly variant?: "raised" | "glass" | "plain";
  readonly filled?: boolean;
  readonly size?: "regular" | "large";
  readonly className?: string;
}

const liquidGlass = isLiquidGlassAvailable();

/** A round icon action with a 44pt hit area. */
export function IconButton({
  icon,
  label,
  variant = "raised",
  filled = false,
  size = "regular",
  className,
  ...props
}: IconButtonProps) {
  const dimension = size === "large" ? "size-14" : "size-11";

  const glyph = (
    <Icon
      icon={icon}
      tone={variant === "glass" ? "onMedia" : "default"}
      size={size === "large" ? 28 : 24}
      filled={filled}
    />
  );

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={4}
      className={`${dimension} items-center justify-center overflow-hidden rounded-pill active:opacity-70 ${
        variant === "raised" ? "bg-surface-raised/80" : ""
      } ${className ?? ""}`}
      {...props}
    >
      {variant === "glass" ? (
        liquidGlass ? (
          <GlassView glassEffectStyle="regular" style={StyleSheet.absoluteFill} />
        ) : (
          <BlurView tint="dark" intensity={40} style={StyleSheet.absoluteFill} />
        )
      ) : null}
      <View>{glyph}</View>
    </Pressable>
  );
}
