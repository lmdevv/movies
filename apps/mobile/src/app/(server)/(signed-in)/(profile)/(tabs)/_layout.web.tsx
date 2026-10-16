/**
 * The tabs in the web preview, drawn like Paper's iOS tab bar: a glass capsule of Home, Movies,
 * Shows, and My List with a separate search circle, over a fade. Scrolling down minimizes it to the
 * current tab's circle and search, as the system bar does on iOS 26.
 */
import { TabList, TabSlot, TabTrigger, Tabs } from "expo-router/ui";
import { LinearGradient } from "expo-linear-gradient";
import type { ComponentType } from "react";
import { useCallback, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import type { PressableProps } from "react-native";

import { TabBarScrollContext } from "@/shell/tab-bar-scroll";
import { black, colors, glass, radius, space } from "@/theme/tokens";
import { Glass } from "@/ui/glass";
import { BookmarkIcon, FilmIcon, HouseIcon, ICON_STROKE, SearchIcon, TvIcon } from "@/ui/icons";
import { Text } from "@/ui/text";

/** A tab in the capsule. */
interface Tab {
  readonly name: "index" | "movies" | "shows" | "my-list";
  readonly href: "/" | "/movies" | "/shows" | "/my-list";
  readonly label: string;
  readonly Icon: ComponentType<{ size: number; color: string; strokeWidth: number }>;
}

const TABS: ReadonlyArray<Tab> = [
  { name: "index", href: "/", label: "Home", Icon: HouseIcon },
  { name: "movies", href: "/movies", label: "Movies", Icon: FilmIcon },
  { name: "shows", href: "/shows", label: "Shows", Icon: TvIcon },
  { name: "my-list", href: "/my-list", label: "My List", Icon: BookmarkIcon },
];

/** Scrolled this far down, the bar minimizes; any scroll up brings it back. */
const MINIMIZE_AFTER = 40;

/** Props `TabTrigger` hands its child. */
interface TriggerChildProps extends PressableProps {
  readonly isFocused?: boolean;
}

function TabButton({
  tab,
  isFocused = false,
  ...pressable
}: TriggerChildProps & { readonly tab: Tab }) {
  const color = isFocused ? colors.accent : colors.text;

  return (
    <Pressable
      {...pressable}
      accessibilityRole="tab"
      accessibilityLabel={tab.label}
      accessibilityState={{ selected: isFocused }}
      style={[styles.tab, isFocused && styles.tabSelected]}
    >
      <tab.Icon size={22} color={color} strokeWidth={ICON_STROKE} />
      <Text variant={isFocused ? "tabSelected" : "tab"} color={color}>
        {tab.label}
      </Text>
    </Pressable>
  );
}

function MinimizedTab({
  tab,
  isFocused = false,
  ...pressable
}: TriggerChildProps & { readonly tab: Tab }) {
  return isFocused ? (
    <Pressable {...pressable} accessibilityRole="tab" accessibilityLabel={tab.label}>
      <Glass interactive radius={radius.pill} style={styles.circle}>
        <tab.Icon size={22} color={colors.accent} strokeWidth={ICON_STROKE} />
      </Glass>
    </Pressable>
  ) : null;
}

function SearchButton({ isFocused = false, ...pressable }: TriggerChildProps) {
  return (
    <Pressable {...pressable} accessibilityRole="tab" accessibilityLabel="Search">
      <Glass interactive radius={radius.pill} style={styles.circle}>
        <SearchIcon size={22} color={isFocused ? colors.accent : colors.text} strokeWidth={2} />
      </Glass>
    </Pressable>
  );
}

export default function TabsLayout() {
  const [minimized, setMinimized] = useState(false);
  const last = useRef(0);

  const report = useCallback((offsetY: number) => {
    const delta = offsetY - last.current;

    last.current = offsetY;

    if (delta > 4 && offsetY > MINIMIZE_AFTER) setMinimized(true);
    else if (delta < -4 || offsetY <= 0) setMinimized(false);
  }, []);

  const fade = useMemo(
    () =>
      minimized
        ? { colors: [black(0), black(0.55), black(0.8)] as const, height: 96 }
        : { colors: [black(0), black(0.85), black(1)] as const, height: 140 },
    [minimized],
  );

  return (
    <TabBarScrollContext.Provider value={report}>
      <Tabs style={styles.root}>
        <TabSlot style={styles.slot} />
        <TabList style={styles.hidden}>
          {TABS.map((tab) => (
            <TabTrigger key={tab.name} name={tab.name} href={tab.href} />
          ))}
          <TabTrigger name="search" href="/search" />
        </TabList>
        <LinearGradient
          colors={fade.colors}
          locations={minimized ? [0, 0.7, 1] : [0, 0.6, 1]}
          style={[styles.fade, { height: fade.height }]}
          pointerEvents="none"
        />
        <View style={styles.bar} accessibilityRole="tablist">
          {minimized ? (
            TABS.map((tab) => (
              <TabTrigger key={tab.name} name={tab.name} asChild>
                <MinimizedTab tab={tab} />
              </TabTrigger>
            ))
          ) : (
            <Glass radius={radius.pill} style={styles.capsule}>
              {TABS.map((tab) => (
                <TabTrigger key={tab.name} name={tab.name} asChild>
                  <TabButton tab={tab} />
                </TabTrigger>
              ))}
            </Glass>
          )}
          {minimized ? <View style={styles.spacer} /> : null}
          <TabTrigger name="search" asChild>
            <SearchButton />
          </TabTrigger>
        </View>
      </Tabs>
    </TabBarScrollContext.Provider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  // The slot grows with its screen by default; bounded, each screen scrolls inside it.
  slot: { flexShrink: 1, minHeight: 0 },
  hidden: { display: "none" },
  fade: { position: "absolute", left: 0, right: 0, bottom: 0 },
  bar: {
    position: "absolute",
    left: 16,
    right: 16,
    bottom: 24,
    flexDirection: "row",
    alignItems: "center",
  },
  capsule: {
    flex: 1,
    height: 62,
    padding: space[1],
    marginRight: space[3],
    flexDirection: "row",
    justifyContent: "space-between",
  },
  spacer: { flex: 1 },
  tab: {
    width: 68,
    height: 54,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
  },
  tabSelected: {
    backgroundColor: glass.selected,
    boxShadow: `inset 0 1px 0 ${glass.selectedHighlight}`,
  },
  circle: {
    width: 62,
    height: 62,
    alignItems: "center",
    justifyContent: "center",
  },
});
