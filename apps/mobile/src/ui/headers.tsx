/**
 * Screen and row headers: the large title with the profile's avatar (`For Alex`), the compact
 * glass bar it collapses into on scroll, and a row's section header with its chevron.
 */
import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import type { StyleProp, ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { PAGE_INSET, colors, opacity, space } from "@/theme/tokens";

import { GlassBar } from "./glass";
import { ChevronRightIcon } from "./icons";
import { Text } from "./text";

/** Props for `LargeTitle`. */
interface LargeTitleProps {
  readonly title: string;
  /** Something on the right, such as the profile's avatar button. */
  readonly accessory?: ReactNode;
  readonly style?: StyleProp<ViewStyle>;
}

/** A screen's 34pt title with an optional accessory on its right. */
export function LargeTitle({ title, accessory, style }: LargeTitleProps) {
  return (
    <View style={[styles.largeTitle, style]}>
      <Text variant="largeTitle" accessibilityRole="header" numberOfLines={1} style={styles.shrink}>
        {title}
      </Text>
      {accessory}
    </View>
  );
}

/** Props for `CompactBar`. */
interface CompactBarProps {
  readonly title: string;
  readonly accessory?: ReactNode;
  readonly style?: StyleProp<ViewStyle>;
}

/** Height of the compact bar's row under the status bar. */
const COMPACT_BAR_HEIGHT = 44;

/** The glass bar a large title collapses into: the title centered, the accessory on the right. */
export function CompactBar({ title, accessory, style }: CompactBarProps) {
  const { top } = useSafeAreaInsets();

  return (
    <GlassBar style={[styles.compactBar, { paddingTop: top }, style]}>
      <View style={styles.compactRow}>
        <Text variant="barTitle" numberOfLines={1}>
          {title}
        </Text>
        {accessory === undefined ? null : <View style={styles.compactAccessory}>{accessory}</View>}
      </View>
    </GlassBar>
  );
}

/** Props for `SectionHeader`. */
interface SectionHeaderProps {
  readonly title: string;
  /** Opens the whole list; without it the chevron is not drawn. */
  readonly onPress?: () => void;
  /** The first header under a hero sits closer to it. */
  readonly first?: boolean;
}

/** A row's header: `Continue watching ›`. */
export function SectionHeader({ title, onPress, first = false }: SectionHeaderProps) {
  const content = (
    <>
      <Text variant="section" accessibilityRole="header">
        {title}
      </Text>
      {onPress === undefined ? null : (
        <ChevronRightIcon size={16} color={colors.textMuted} strokeWidth={2.25} />
      )}
    </>
  );

  const style = [styles.section, first ? styles.sectionFirst : null];

  return onPress === undefined ? (
    <View style={style}>{content}</View>
  ) : (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`See all ${title}`}
      onPress={onPress}
      style={({ pressed }) => [style, pressed && styles.pressed]}
    >
      {content}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  largeTitle: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space[3],
    paddingHorizontal: PAGE_INSET,
    paddingTop: space[1],
  },
  shrink: { flexShrink: 1 },
  compactBar: { position: "absolute", top: 0, left: 0, right: 0 },
  compactRow: {
    height: COMPACT_BAR_HEIGHT,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 64,
  },
  compactAccessory: { position: "absolute", right: PAGE_INSET, top: 7 },
  section: {
    flexDirection: "row",
    alignItems: "center",
    gap: space[1],
    alignSelf: "flex-start",
    paddingHorizontal: PAGE_INSET,
    paddingTop: space[6],
    paddingBottom: 10,
  },
  sectionFirst: { paddingTop: space[3] },
  pressed: { opacity: opacity.pressed },
});
