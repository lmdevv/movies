/**
 * The header of the browse tabs: a 34pt large title that scrolls with the content (C01) and, once
 * it has scrolled away, a compact 20pt title on a glass bar that stays at the top (C02). The
 * trailing buttons, such as the profile avatar, stay put in both states.
 */
import { BlurView } from "expo-blur";
import { useCallback, useState } from "react";
import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import type { NativeScrollEvent, NativeSyntheticEvent } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useUniwind } from "uniwind";

import { Text } from "@/components/ui/text";

/** How far the content scrolls before the large title is gone and the bar takes over. */
const COLLAPSE_AT = 48;

/** Whether the large title has scrolled away, and the scroll handler that tracks it. */
export interface Collapse {
  readonly collapsed: boolean;
  readonly onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
}

/** Tracks a screen's scroll for the compact bar; re-renders only when it crosses the threshold. */
export const useCollapse = (): Collapse => {
  const [collapsed, setCollapsed] = useState(false);

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    setCollapsed(event.nativeEvent.contentOffset.y > COLLAPSE_AT);
  }, []);

  return { collapsed, onScroll };
};

/** The large title row, the first thing in a tab's content, under the status bar. */
export function LargeTitle({
  title,
  overMedia = false,
}: {
  readonly title: string;
  /** White over hero artwork, whatever the theme. */
  readonly overMedia?: boolean;
}) {
  const insets = useSafeAreaInsets();

  return (
    <View style={{ paddingTop: insets.top }}>
      {/* The trailing buttons sit in the fixed bar above; keep their 44pt clear. */}
      <View className="h-16 flex-row items-center pr-16 pl-5">
        <Text
          variant="largeTitle"
          tone={overMedia ? "onMedia" : "default"}
          numberOfLines={1}
          accessibilityRole="header"
        >
          {title}
        </Text>
      </View>
    </View>
  );
}

/**
 * The fixed bar over a tab: transparent with only the trailing buttons until the large title has
 * scrolled away, then a glass bar with the compact title.
 */
export function CompactBar({
  title,
  collapsed,
  trailing,
}: {
  readonly title: string;
  readonly collapsed: boolean;
  readonly trailing?: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const { theme } = useUniwind();

  return (
    <View className="absolute inset-x-0 top-0" style={{ paddingTop: insets.top }}>
      {collapsed ? (
        <Animated.View
          entering={FadeIn.duration(180)}
          exiting={FadeOut.duration(180)}
          style={StyleSheet.absoluteFill}
        >
          <BlurView
            tint={theme === "light" ? "systemChromeMaterialLight" : "systemChromeMaterialDark"}
            intensity={100}
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>
      ) : null}
      <View className="h-16 flex-row items-center gap-3 px-5">
        <View className="flex-1">
          {collapsed ? (
            <Animated.View entering={FadeIn.duration(180)} exiting={FadeOut.duration(120)}>
              <Text variant="navTitle" numberOfLines={1}>
                {title}
              </Text>
            </Animated.View>
          ) : null}
        </View>
        {trailing}
      </View>
    </View>
  );
}
