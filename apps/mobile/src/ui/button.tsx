/**
 * The iOS page's buttons: the red primary pill (primary actions only), the secondary pill on a
 * white tint or on glass, and round icon buttons. Each is 50pt tall unless sized otherwise.
 */
import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import type { StyleProp, ViewStyle } from "react-native";
import Svg, { Path } from "react-native-svg";

import { colors, glass, opacity, overlay, radius, space } from "@/theme/tokens";

import { Glass } from "./glass";
import { Text } from "./text";

/** Height of a pill button. */
const PILL_HEIGHT = 50;

/** What every button takes. */
interface ButtonBase {
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly style?: StyleProp<ViewStyle>;
}

/** Props for `PrimaryButton`. */
interface PrimaryButtonProps extends ButtonBase {
  readonly label: string;
  /** A glyph before the label, such as `PlayGlyph`. */
  readonly icon?: ReactNode;
  /** Shows a spinner in place of the label while the action runs. */
  readonly pending?: boolean;
}

/** The red pill for a screen's main action: `Continue`, `Sign in`, `Resume`. */
export function PrimaryButton({
  label,
  icon,
  pending = false,
  disabled = false,
  onPress,
  style,
}: PrimaryButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled || pending, busy: pending }}
      disabled={disabled || pending}
      onPress={onPress}
      style={({ pressed }) => [
        styles.pill,
        styles.primary,
        pressed && styles.primaryPressed,
        disabled && styles.disabled,
        style,
      ]}
    >
      {pending ? (
        <ActivityIndicator color={colors.onAccent} />
      ) : (
        <>
          {icon}
          <Text variant="button" color={colors.onAccent}>
            {label}
          </Text>
        </>
      )}
    </Pressable>
  );
}

/** Props for `SecondaryButton`. */
interface SecondaryButtonProps extends ButtonBase {
  readonly label: string;
  readonly icon?: ReactNode;
  /** `tint` is a white wash over the page; `glass` is the glass material over art. */
  readonly surface?: "tint" | "glass";
}

/** The secondary pill beside or below a primary action. */
export function SecondaryButton({
  label,
  icon,
  surface = "tint",
  disabled = false,
  onPress,
  style,
}: SecondaryButtonProps) {
  const content = (
    <>
      {icon}
      <Text variant="buttonSecondary">{label}</Text>
    </>
  );

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [pressed && styles.pressed, disabled && styles.disabled, style]}
    >
      {surface === "glass" ? (
        <Glass interactive radius={radius.pill} style={styles.pill}>
          {content}
        </Glass>
      ) : (
        <View style={[styles.pill, styles.tint]}>{content}</View>
      )}
    </Pressable>
  );
}

/** Props for `IconButton`. */
interface IconButtonProps extends ButtonBase {
  /** What the button does, for VoiceOver: `Add to My List`. */
  readonly label: string;
  readonly icon: ReactNode;
  /** Diameter: 44 to 62 on the iOS page. */
  readonly size?: number;
  /** `tint` is a white wash over art; `glass` the glass material. */
  readonly surface?: "tint" | "glass";
  /** Marks a toggle's state for VoiceOver. */
  readonly selected?: boolean;
}

/** A round icon button, such as My List beside Resume or the search circle. */
export function IconButton({
  label,
  icon,
  size = PILL_HEIGHT,
  surface = "glass",
  selected,
  disabled = false,
  onPress,
  style,
}: IconButtonProps) {
  const circle = { width: size, height: size, borderRadius: size / 2 };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={size < 44 ? (44 - size) / 2 : 0}
      style={({ pressed }) => [pressed && styles.pressed, disabled && styles.disabled, style]}
    >
      {surface === "glass" ? (
        <Glass interactive radius={size / 2} style={[styles.round, circle]}>
          {icon}
        </Glass>
      ) : (
        <View style={[styles.round, styles.roundTint, circle]}>{icon}</View>
      )}
    </Pressable>
  );
}

/** Props for `PlayGlyph`. */
interface PlayGlyphProps {
  readonly size?: number;
  readonly color?: string;
}

/** The filled play triangle on Play and Resume. */
export function PlayGlyph({ size = 16, color = colors.onAccent }: PlayGlyphProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d="M7 4v16l13-8z" fill={color} />
    </Svg>
  );
}

const styles = StyleSheet.create({
  pill: {
    height: PILL_HEIGHT,
    borderRadius: radius.pill,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space[2],
    paddingHorizontal: 20,
  },
  primary: { backgroundColor: colors.accent },
  primaryPressed: { backgroundColor: colors.accentPressed },
  tint: {
    backgroundColor: glass.secondaryFill,
    borderWidth: 1,
    borderColor: glass.secondaryBorder,
  },
  round: { alignItems: "center", justifyContent: "center" },
  roundTint: {
    backgroundColor: overlay.button,
    borderWidth: 1,
    borderColor: overlay.buttonBorder,
  },
  pressed: { opacity: opacity.pressed },
  disabled: { opacity: opacity.disabled },
});
