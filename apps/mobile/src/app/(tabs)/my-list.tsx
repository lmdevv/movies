/** The My List tab. */
import { Screen } from "@/components/ui/screen";
import { Text } from "@/components/ui/text";

export default function Tab() {
  return (
    <Screen edges={["top"]} contentClassName="px-5">
      <Text variant="largeTitle" accessibilityRole="header">
        My List
      </Text>
    </Screen>
  );
}
