/**
 * The floating glass tab bar (Home, Movies, Shows, My List) with the separate search circle, as
 * iOS draws it natively: it minimizes as the content scrolls down.
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
      <NativeTabs.Trigger name="movies">
        <NativeTabs.Trigger.Icon sf="film.stack" />
        <NativeTabs.Trigger.Label>Movies</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="shows">
        <NativeTabs.Trigger.Icon sf={{ default: "tv", selected: "tv.fill" }} />
        <NativeTabs.Trigger.Label>Shows</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="my-list">
        <NativeTabs.Trigger.Icon sf={{ default: "bookmark", selected: "bookmark.fill" }} />
        <NativeTabs.Trigger.Label>My List</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="search" role="search">
        <NativeTabs.Trigger.Icon sf="magnifyingglass" />
        <NativeTabs.Trigger.Label>Search</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
