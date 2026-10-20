/**
 * The Downloads tab's content. C20 · Downloads · Empty: a download glyph in a circle, the line,
 * and Browse Library, which returns to Home.
 */
import { router } from "expo-router";
import { Download } from "lucide-react-native";
import { ScrollView } from "react-native";

import { EmptyState } from "@/components/browse/empty-state";
import { Button } from "@/components/ui/button";

/** What the Downloads tab shows. */
export function DownloadsTab() {
  return (
    // The automatic insets already clear the tab bar and the home indicator.
    <ScrollView contentInsetAdjustmentBehavior="automatic" className="flex-1 bg-bg">
      <EmptyState
        icon={Download}
        title="Nothing downloaded yet."
        action={<Button label="Browse Library" onPress={() => router.navigate("/")} />}
      />
    </ScrollView>
  );
}
