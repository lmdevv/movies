/**
 * The Downloads tab's content. C20 · Downloads · Empty: a download glyph in a circle, the line,
 * and Browse Library, which returns to Home.
 */
import { router } from "expo-router";
import { Download } from "lucide-react-native";
import { ScrollView } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { EmptyState } from "@/components/browse/empty-state";
import { TAB_BAR_CLEARANCE } from "@/components/browse/layout";
import { Button } from "@/components/ui/button";

/** What the Downloads tab shows. */
export function DownloadsTab() {
  const insets = useSafeAreaInsets();

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      className="flex-1 bg-bg"
      contentContainerStyle={{ paddingBottom: insets.bottom + TAB_BAR_CLEARANCE }}
    >
      <EmptyState
        icon={Download}
        title="Nothing downloaded yet."
        action={<Button label="Browse Library" onPress={() => router.navigate("/")} />}
      />
    </ScrollView>
  );
}
