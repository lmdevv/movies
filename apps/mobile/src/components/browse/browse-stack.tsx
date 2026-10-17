/**
 * The stack inside the Movies and Shows tabs: the tab itself and its Sort, Filter, and Genres
 * sheets, presented as native form sheets with a grabber over the raised surface (C14, C15).
 */
import type { TitleKind } from "@movies/contracts/models/catalog";
import { Stack } from "expo-router";
import { useCSSVariable } from "uniwind";

import { useThemeColor } from "@/lib/theme-color";

import { FiltersProvider } from "./filters";

/** The sheets each tab presents. */
const SHEETS = ["sort", "filter", "genres"] as const;

/** A browse tab's stack with its filters. */
export function BrowseStack({ kind }: { readonly kind: TitleKind }) {
  const surface = useThemeColor("--color-surface-raised");
  // Native sheets take the radius in points; the token is `28px`.
  const radius = Number.parseFloat(String(useCSSVariable("--radius-sheet")));

  return (
    <FiltersProvider kind={kind}>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="index" />
        {SHEETS.map((name) => (
          <Stack.Screen
            key={name}
            name={name}
            options={{
              presentation: "formSheet",
              sheetGrabberVisible: true,
              sheetAllowedDetents: name === "genres" ? [0.6, 1] : "fitToContents",
              sheetCornerRadius: radius,
              contentStyle: { backgroundColor: surface },
            }}
          />
        ))}
      </Stack>
    </FiltersProvider>
  );
}
