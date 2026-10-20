/**
 * The floating glass tab bar (C01): Home and Downloads, with Search as the system search tab in
 * its own circle, as iOS draws it natively. Scrolling down minimizes the bar to a Home circle and
 * the Search circle (C02). Selecting Search turns the bar into the search field with the keyboard
 * up (E00).
 */
import { NativeTabs } from "expo-router/native-tabs";

import { useThemeColor } from "@/lib/theme-color";

export default function TabsLayout() {
  const accent = useThemeColor("--color-accent");

  return (
    <NativeTabs minimizeBehavior="onScrollDown" tintColor={accent}>
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Icon sf={{ default: "house", selected: "house.fill" }} />
        <NativeTabs.Trigger.Label>Home</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="downloads">
        <NativeTabs.Trigger.Icon sf="arrow.down.to.line" />
        <NativeTabs.Trigger.Label>Downloads</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger
        name="search"
        role="search"
        unstable_nativeProps={{ ios: { role: "search", automaticallyActivatesSearch: true } }}
      >
        <NativeTabs.Trigger.Icon sf="magnifyingglass" />
        <NativeTabs.Trigger.Label>Search</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
