/**
 * C17 · Return to Room: the pill under Home's title while this device is in a watch room, with how
 * many are in it. It opens the room's page, where the artwork leads back into the player.
 */
import { router } from "expo-router";
import { ChevronRight } from "lucide-react-native";
import { Pressable, View } from "react-native";

import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { useCurrentRoom } from "@/session/current-room";

/** The pill, or nothing outside rooms. */
export function ReturnToRoom() {
  const room = useCurrentRoom();

  if (room === null) return null;

  const label = `Return to Room · ${String(room.members)}`;

  return (
    <View className="flex-row px-5 pt-4" pointerEvents="box-none">
      <Pressable
        onPress={() => router.push(`/room/${room.id}`)}
        accessibilityRole="button"
        accessibilityLabel={label}
        className="h-9 flex-row items-center gap-2 rounded-pill bg-dark-surface-raised px-4 active:opacity-70"
      >
        <View className="size-1.5 rounded-pill bg-accent" />
        <Text variant="labelStrong" tone="onMedia">
          {label}
        </Text>
        <Icon icon={ChevronRight} tone="onMedia" size="chevron" />
      </Pressable>
    </View>
  );
}
