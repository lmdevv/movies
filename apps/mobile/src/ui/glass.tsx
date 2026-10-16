/**
 * Liquid glass surfaces. On iOS 26 and later this is the system material (`GlassView`); elsewhere
 * (older iOS, the web preview) it is Paper's recipe: a translucent fill over a blur with a hairline
 * border, a top highlight, and a soft shadow.
 */
import { BlurView } from "expo-blur";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import type { StyleProp, ViewStyle } from "react-native";

import { glass } from "@/theme/tokens";

const systemGlass = isLiquidGlassAvailable();

/** Props for `Glass`. */
interface GlassProps {
  /** Corner radius of the surface; the blur is clipped to it. */
  readonly radius: number;
  /** Size and layout of the surface. */
  readonly style?: StyleProp<ViewStyle>;
  /** Whether the system glass reacts to touches, for buttons. */
  readonly interactive?: boolean;
  readonly children?: ReactNode;
}

/** A glass control surface, such as the tab bar capsule or a round button, holding `children`. */
export function Glass({ radius, style, interactive = false, children }: GlassProps) {
  const corners = { borderRadius: radius };

  if (systemGlass) {
    return (
      <GlassView
        style={[corners, style]}
        glassEffectStyle="regular"
        colorScheme="dark"
        isInteractive={interactive}
      >
        {children}
      </GlassView>
    );
  }

  return (
    <View style={[styles.surface, corners, style]}>
      <View style={[StyleSheet.absoluteFill, styles.layer, corners]}>
        <BlurView intensity={BLUR_INTENSITY} tint="dark" style={StyleSheet.absoluteFill} />
        <View style={[StyleSheet.absoluteFill, styles.fill]} />
      </View>
      {children}
    </View>
  );
}

/** Props for `GlassBar`. */
interface GlassBarProps {
  readonly style?: StyleProp<ViewStyle>;
  readonly children?: ReactNode;
}

/** The compact glass bar across the top of a scrolled screen. */
export function GlassBar({ style, children }: GlassBarProps) {
  return (
    <View style={[styles.bar, style]}>
      <View style={[StyleSheet.absoluteFill, styles.layer]}>
        <BlurView intensity={BLUR_INTENSITY} tint="dark" style={StyleSheet.absoluteFill} />
        <View style={[StyleSheet.absoluteFill, styles.barFill]} />
      </View>
      {children}
    </View>
  );
}

/** expo-blur at full strength, the closest it comes to Paper's 24px blur. */
const BLUR_INTENSITY = 100;

// The blur sits under the content: on the web an absolutely positioned layer would otherwise paint
// over unpositioned children such as icons.
const styles = StyleSheet.create({
  surface: {
    zIndex: 0,
    borderWidth: 1,
    borderColor: glass.border,
    boxShadow: `inset 0 1px 0 ${glass.highlight}, 0 10px 30px ${glass.shadow}`,
  },
  layer: { zIndex: -1, overflow: "hidden" },
  fill: { backgroundColor: glass.fill },
  bar: { zIndex: 0, borderBottomWidth: 1, borderBottomColor: glass.barBorder },
  barFill: { backgroundColor: glass.bar },
});
