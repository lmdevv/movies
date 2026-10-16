/**
 * A bottom sheet over a dimmed screen: `#1C1C1E` with rounded top corners and a grabber. Tapping
 * the dimmed screen or swiping back closes it. For a sheet that is a route of its own, prefer the
 * Stack's native `formSheet` presentation.
 */
import type { ReactNode } from "react";
import { Modal, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { colors, glass, system } from "@/theme/tokens";

/** Props for `BottomSheet`. */
interface BottomSheetProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly children: ReactNode;
}

/** Top corner radius of a sheet. */
const SHEET_RADIUS = 28;

/** A modal sheet from the bottom edge holding `children`. */
export function BottomSheet({ open, onClose, children }: BottomSheetProps) {
  const { bottom } = useSafeAreaInsets();

  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable accessibilityLabel="Close" style={styles.scrim} onPress={onClose} />
      <View style={[styles.sheet, { paddingBottom: Math.max(bottom, 16) }]}>
        <View style={styles.grabber} />
        {children}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: colors.scrim },
  sheet: {
    borderTopLeftRadius: SHEET_RADIUS,
    borderTopRightRadius: SHEET_RADIUS,
    backgroundColor: system.fill,
    paddingTop: 22,
  },
  grabber: {
    position: "absolute",
    top: 6,
    alignSelf: "center",
    width: 36,
    height: 5,
    borderRadius: 3,
    backgroundColor: glass.grabber,
  },
});
