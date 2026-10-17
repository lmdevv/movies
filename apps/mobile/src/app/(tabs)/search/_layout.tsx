/**
 * The Search tab's stack, so the screen gets the native header with a large title and the system
 * search field (E01–E05).
 */
import { Stack } from "expo-router";
import { useCSSVariable } from "uniwind";

import { useThemeColor } from "@/lib/theme-color";

export default function SearchLayout() {
  const background = useThemeColor("--color-bg");
  const text = useThemeColor("--color-text");
  const bold = useCSSVariable("--font-sans-bold");
  const semibold = useCSSVariable("--font-sans-semibold");

  return (
    <Stack
      screenOptions={{
        headerLargeTitle: true,
        headerStyle: { backgroundColor: background },
        headerShadowVisible: false,
        headerLargeTitleShadowVisible: false,
        headerTintColor: text,
        headerLargeTitleStyle: { fontFamily: String(bold), color: text },
        headerTitleStyle: { fontFamily: String(semibold), color: text },
        contentStyle: { backgroundColor: background },
      }}
    >
      <Stack.Screen name="index" options={{ title: "Search" }} />
    </Stack>
  );
}
