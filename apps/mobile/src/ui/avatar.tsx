/**
 * Profile avatars from Paper's 00 Artwork kit: a gradient per avatar key with the name's first
 * letter, or the `kids` lettering. Keys this app does not know (from another client) draw a plain
 * tile with the letter.
 */
import { LinearGradient } from "expo-linear-gradient";
import { StyleSheet, View } from "react-native";

import { avatarGradients } from "@/theme/gradients";
import { colors, radius, system } from "@/theme/tokens";

import { Text } from "./text";

/** Props for `Avatar`. */
interface AvatarProps {
  /** The profile's avatar key, such as `red` or `kids`. */
  readonly avatar: string;
  /** The profile's name; its first letter goes on the avatar. */
  readonly name: string;
  readonly size: number;
  /** `tile` is the rounded square of Who's watching; `circle` the one in headers. */
  readonly variant: "tile" | "circle";
}

const isKnown = (key: string): key is keyof typeof avatarGradients => key in avatarGradients;

/** A profile's avatar at `size` points. */
export function Avatar({ avatar, name, size, variant }: AvatarProps) {
  const frame = {
    width: size,
    height: size,
    borderRadius: variant === "circle" ? size / 2 : (size * radius.tile) / 96,
  };

  const kids = avatar === "kids";
  // Paper sets the letter at 44pt on a 96pt tile and the `kids` lettering at 30pt.
  const fontSize = Math.round(size * (kids ? 30 / 96 : 44 / 96));

  const label = (
    <Text
      variant={kids ? "display" : "largeTitle"}
      style={{
        fontSize,
        lineHeight: Math.round(fontSize * 1.1),
        letterSpacing: fontSize * (kids ? -0.03 : -0.02),
      }}
      accessibilityElementsHidden
      importantForAccessibility="no"
    >
      {kids ? "kids" : name.trim().charAt(0).toUpperCase()}
    </Text>
  );

  if (!isKnown(avatar)) {
    return <View style={[styles.avatar, styles.unknown, frame]}>{label}</View>;
  }

  const { colors: stops, locations } = avatarGradients[avatar];

  return (
    <LinearGradient
      colors={stops}
      locations={locations}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={[styles.avatar, frame]}
    >
      {label}
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  avatar: { alignItems: "center", justifyContent: "center", overflow: "hidden" },
  unknown: { backgroundColor: system.fillRaised, borderColor: colors.hairline, borderWidth: 1 },
});
