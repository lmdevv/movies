/**
 * Grouped lists in the iOS Settings style: rows on a rounded `#1C1C1E` group with hairline
 * separators inset past each row's leading glyph.
 */
import { Children, Fragment } from "react";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { colors, opacity, radius, space, system } from "@/theme/tokens";

import { ChevronRightIcon } from "./icons";
import { Text } from "./text";

/** Height of a row with a subtitle. */
const ROW_HEIGHT = 64;

/** Props for `GroupedList`. */
interface GroupedListProps {
  /** `ListRow`s; a separator goes between each. */
  readonly children: ReactNode;
  /** Where separators start, from the group's left edge. */
  readonly separatorInset?: number;
}

/** A rounded group of rows. */
export function GroupedList({ children, separatorInset = 16 }: GroupedListProps) {
  const rows = Children.toArray(children);

  return (
    <View style={styles.group}>
      {rows.map((row, index) => (
        <Fragment key={index}>
          {index === 0 ? null : <View style={[styles.separator, { marginLeft: separatorInset }]} />}
          {row}
        </Fragment>
      ))}
    </View>
  );
}

/** Props for `ListRow`. */
interface ListRowProps {
  readonly title: string;
  readonly subtitle?: string | undefined;
  /** `mono` for addresses and paths. */
  readonly subtitleFont?: "sans" | "mono";
  /** A glyph or tile before the text. */
  readonly leading?: ReactNode;
  /** A value or control after the text; a chevron when the row opens something. */
  readonly trailing?: ReactNode;
  readonly onPress?: () => void;
}

/** One row of a grouped list. */
export function ListRow({
  title,
  subtitle,
  subtitleFont = "sans",
  leading,
  trailing,
  onPress,
}: ListRowProps) {
  const content = (
    <>
      {leading}
      <View style={styles.text}>
        <Text variant="bodyStrong" numberOfLines={1}>
          {title}
        </Text>
        {subtitle === undefined ? null : (
          <Text
            variant={subtitleFont === "mono" ? "monoCaption" : "caption"}
            color={colors.textMuted}
            numberOfLines={1}
          >
            {subtitle}
          </Text>
        )}
      </View>
      {trailing ??
        (onPress === undefined ? null : (
          <ChevronRightIcon size={16} color={system.chevron} strokeWidth={2} />
        ))}
    </>
  );

  return onPress === undefined ? (
    <View style={styles.row}>{content}</View>
  ) : (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      {content}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  group: { borderRadius: radius.card, overflow: "hidden", backgroundColor: system.fill },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: system.separator },
  row: {
    minHeight: ROW_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingHorizontal: space[4],
    paddingVertical: 10,
  },
  text: { flex: 1, gap: 2 },
  pressed: { opacity: opacity.pressed },
});
