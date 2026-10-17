/**
 * The bar that follows removing a title from My List: says what left and offers Undo for a few
 * seconds, so the change is reversible from the list itself.
 */
import { View } from "react-native";
import Animated, { FadeInDown, FadeOutDown } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";

import { TAB_BAR_CLEARANCE } from "./layout";
import { useTitleStates } from "./title-states";

/** Undo for the last removal from My List, while it is offered: above the tab bar or the screen's bottom edge. */
export function UndoBar({ above }: { readonly above: "tabBar" | "screen" }) {
  const { removed, undoRemove } = useTitleStates();
  const insets = useSafeAreaInsets();

  if (removed === null) return null;

  return (
    <View
      className="absolute inset-x-4"
      style={{ bottom: insets.bottom + (above === "tabBar" ? TAB_BAR_CLEARANCE : 0) }}
    >
      <Animated.View entering={FadeInDown.duration(200)} exiting={FadeOutDown.duration(200)}>
        <View className="flex-row items-center gap-3 rounded-pill bg-surface-raised py-1 pr-1 pl-5">
          <Text variant="label" className="flex-1" numberOfLines={1}>
            {`Removed ${removed.name}`}
          </Text>
          <Button
            label="Undo"
            variant="plain"
            className="h-11 px-4"
            onPress={() => void undoRemove()}
          />
        </View>
      </Animated.View>
    </View>
  );
}
