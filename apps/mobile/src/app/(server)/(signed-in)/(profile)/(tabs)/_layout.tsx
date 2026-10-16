/**
 * The four tabs and the search tab on iPhone: the system tab bar, which is Liquid Glass on iOS 26
 * with search as its own circle and minimizes while scrolling down. Icons are the SF Symbols
 * closest to Paper's Lucide glyphs, drawn as outlines in every state as Paper does.
 */
import { NativeTabs } from "expo-router/native-tabs";

import { colors } from "@/theme/tokens";

export default function TabsLayout() {
  return (
    <NativeTabs minimizeBehavior="onScrollDown" tintColor={colors.accent}>
      <NativeTabs.Trigger name="index" disableAutomaticContentInsets>
        <NativeTabs.Trigger.Label>Home</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="house" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="movies">
        <NativeTabs.Trigger.Label>Movies</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="film" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="shows">
        <NativeTabs.Trigger.Label>Shows</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="tv" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="my-list">
        <NativeTabs.Trigger.Label>My List</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="bookmark" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="search" role="search">
        <NativeTabs.Trigger.Label>Search</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="magnifyingglass" />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
