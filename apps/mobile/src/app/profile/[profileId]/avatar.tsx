/** B04 · Choose Avatar: the avatar set in a three-column grid; the check keeps the choice. */
import { router } from "expo-router";
import { Check } from "lucide-react-native";
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { useProfileEditor } from "@/components/profile-editor";
import { ProfileAvatar } from "@/components/profile-avatar";
import { IconButton } from "@/components/ui/icon-button";
import { NavHeader } from "@/components/ui/nav-header";
import { Screen } from "@/components/ui/screen";
import { AVATAR_KEYS, avatarLabel } from "@/lib/avatars";

const COLUMNS = 3;

/** The keys in rows of three, the last row padded so tiles keep their columns. */
const ROWS = Array.from({ length: Math.ceil(AVATAR_KEYS.length / COLUMNS) }, (_row, row) =>
  Array.from({ length: COLUMNS }, (_cell, column) => AVATAR_KEYS[row * COLUMNS + column] ?? null),
);

export default function ChooseAvatar() {
  const { draft, change } = useProfileEditor();
  const [avatar, setAvatar] = useState(draft.avatar);

  return (
    <Screen
      header={
        <NavHeader
          title="Choose Avatar"
          trailing={
            <IconButton
              icon={Check}
              label="Done"
              onPress={() => {
                change((current) => ({ ...current, avatar }));
                router.back();
              }}
            />
          }
        />
      }
    >
      <ScrollView contentContainerClassName="gap-4 px-5 py-4">
        <View className="h-12" />
        {ROWS.map((row, index) => (
          <View key={index} className="flex-row justify-between gap-3">
            {row.map((key, column) =>
              key === null ? (
                <View key={`blank-${column}`} className="size-26" />
              ) : (
                <Pressable
                  key={key}
                  accessibilityRole="button"
                  accessibilityLabel={avatarLabel(key)}
                  accessibilityState={{ selected: key === avatar }}
                  onPress={() => setAvatar(key)}
                  className="active:opacity-70"
                >
                  <ProfileAvatar
                    profile={{
                      name: draft.name === "" ? "?" : draft.name,
                      kids: draft.kids,
                      avatar: key,
                    }}
                    size="picker"
                    selected={key === avatar}
                  />
                </Pressable>
              ),
            )}
          </View>
        ))}
      </ScrollView>
    </Screen>
  );
}
