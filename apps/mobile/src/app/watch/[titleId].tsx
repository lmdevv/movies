/** F01 · Player. */
import { CalmState } from "@/components/ui/calm-state";
import { Button } from "@/components/ui/button";
import { Screen } from "@/components/ui/screen";
import { router } from "expo-router";

export default function Watch() {
  return (
    <Screen>
      <CalmState title="Player" actions={<Button label="Close" onPress={() => router.back()} />} />
    </Screen>
  );
}
