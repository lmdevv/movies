/** The short danger-colored line under a refused field or action. */
import { StyleSheet, View } from "react-native";

import { colors } from "@/theme/tokens";

import { CircleAlertIcon } from "./icons";
import { Text } from "./text";

/** Props for `ErrorLine`. */
interface ErrorLineProps {
  readonly message: string;
}

/** An alert glyph and `message` in the danger color, announced to VoiceOver. */
export function ErrorLine({ message }: ErrorLineProps) {
  return (
    <View style={styles.line} accessibilityRole="alert" accessibilityLiveRegion="polite">
      <CircleAlertIcon size={15} color={colors.danger} strokeWidth={2} />
      <Text variant="labelMedium" color={colors.danger} style={styles.text}>
        {message}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  line: { flexDirection: "row", alignItems: "center", gap: 6, paddingLeft: 2 },
  text: { flexShrink: 1 },
});
