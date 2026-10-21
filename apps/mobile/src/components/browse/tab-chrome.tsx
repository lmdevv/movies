/**
 * The chrome of Home: a 34pt large title that scrolls with the content (C01) and, once it has
 * scrolled away, the scroll edge effect (C02). The content runs under a bar that fades from the
 * page into it, with a compact 20pt title, and a soft fade rises behind the tab bar. The trailing
 * buttons, such as the profile avatar, stay put in both states.
 */
import { LinearGradient } from "expo-linear-gradient";
import { useCallback, useState } from "react";
import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import type { LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Text } from "@/components/ui/text";
import { useThemeColor } from "@/lib/theme-color";

/** How far the content scrolls before the large title is gone and the bar takes over. */
const COLLAPSE_AT = 48;

/**
 * C02's top fade, hung below the bar: the page's color, then Paper's scrim, then clear. Light fades
 * the same way through white. The bar itself stays the page's color, so the compact title never
 * sits over half-faded artwork or the hero's Play button.
 */
const TOP_FADE_LOCATIONS = [0, 0.45, 1] as const;

/** How far the top fade reaches past the title row, in points (Paper's 140 less 126). */
const TOP_FADE_TAIL = 14;

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
 * The bar over Home, the scroll view's sticky first child so the scroll view stays the page's
 * root, where UIKit finds it to minimize the tab bar: only the trailing buttons until the large
 * title has scrolled away, then the top fade with the compact title. The page moves its content up
 * by the height `onLayout` reports, so the content starts under the bar.
 */
export function CompactBar({
  title,
  collapsed,
  trailing,
  onLayout,
}: {
  readonly title: string;
  readonly collapsed: boolean;
  readonly trailing?: ReactNode;
  readonly onLayout?: (event: LayoutChangeEvent) => void;
}) {
  const insets = useSafeAreaInsets();
  const page = useThemeColor("--color-bg");
  const fade = useThemeColor("--color-bg-fade");
  const clear = useThemeColor("--color-bg-clear");

  return (
    // The sticky header takes this style, so `pointerEvents` lives here: touches outside the
    // trailing buttons reach the content under the bar.
    <View
      style={{ paddingTop: insets.top, paddingBottom: TOP_FADE_TAIL, pointerEvents: "box-none" }}
      onLayout={onLayout}
    >
      {collapsed ? (
        <Animated.View
          entering={FadeIn.duration(180)}
          exiting={FadeOut.duration(180)}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        >
          <View className="absolute inset-0 bg-bg" />
          <View className="absolute inset-x-0 top-full h-10">
            <LinearGradient
              colors={[page, fade, clear]}
              locations={TOP_FADE_LOCATIONS}
              style={StyleSheet.absoluteFill}
            />
          </View>
        </Animated.View>
      ) : null}
      <View className="h-16 flex-row items-center gap-3 px-5" pointerEvents="box-none">
        <View className="flex-1" pointerEvents="none">
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
