/** A calm centered state for empty screens and failures: a glyph, a title, a line, and actions. */
import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";

import { colors, overlay, space } from "@/theme/tokens";

import { Text } from "./text";

/** Props for `CalmState`. */
interface CalmStateProps {
  readonly title: string;
  readonly description?: string | undefined;
  /** A glyph drawn in a soft circle above the title. */
  readonly icon?: ReactNode;
  /** Buttons under the text, such as `Try again`. */
  readonly actions?: ReactNode;
}

/** Centered title, description, and actions filling the space it is given. */
export function CalmState({ title, description, icon, actions }: CalmStateProps) {
  return (
    <View style={styles.state}>
      {icon === undefined ? null : <View style={styles.well}>{icon}</View>}
      <View style={styles.text}>
        <Text variant="stateTitle" accessibilityRole="header" style={styles.center}>
          {title}
        </Text>
        {description === undefined ? null : (
          <Text variant="body" color={colors.textMuted} style={styles.center}>
            {description}
          </Text>
        )}
      </View>
      {actions}
    </View>
  );
}

const styles = StyleSheet.create({
  state: {
    flexGrow: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: space[6],
    paddingHorizontal: 36,
  },
  well: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: overlay.well,
  },
  text: { alignItems: "center", gap: space[2] },
  center: { textAlign: "center" },
});
