/**
 * The body of the title screens' native form sheets (D05 Seasons, D06 Choose Version, D07 Episode
 * Actions, D10 title actions): a 22pt heading with a close button, an optional muted line, then
 * 56pt rows 16pt apart on the raised surface. iOS draws the grabber and sizes the sheet to fit.
 */
import { router } from "expo-router";
import { X } from "lucide-react-native";
import type { ReactNode } from "react";
import { ActivityIndicator, View } from "react-native";

import { IconButton } from "@/components/ui/icon-button";
import { Text } from "@/components/ui/text";

/** Props for `Sheet`. */
export interface SheetProps {
  readonly title: string;
  readonly subtitle?: string | undefined;
  /** A short danger line under the rows when an action failed. */
  readonly error?: string | null;
  /** Shows a spinner in place of the rows while their data loads. */
  readonly loading?: boolean;
  readonly children?: ReactNode;
}

/** A form sheet's content. */
export function Sheet({ title, subtitle, error, loading = false, children }: SheetProps) {
  return (
    <View className="gap-4 bg-surface-raised px-5 pt-6 pb-4">
      <View className="flex-row items-center gap-3">
        <Text variant="heading" className="flex-1" numberOfLines={2} accessibilityRole="header">
          {title}
        </Text>
        <IconButton icon={X} label="Close" variant="plain" onPress={() => router.back()} />
      </View>
      {subtitle === undefined ? null : (
        <Text variant="secondary" tone="muted">
          {subtitle}
        </Text>
      )}
      {loading ? (
        <ActivityIndicator className="py-6" colorClassName="accent-text-muted" />
      ) : (
        children
      )}
      {error === null || error === undefined ? null : (
        <Text variant="meta" tone="danger" accessibilityLiveRegion="polite">
          {error}
        </Text>
      )}
    </View>
  );
}

/** Closes the sheet, then opens `href` from the screen under it, such as the player. */
export const leaveSheetFor = (href: string): void => {
  router.back();
  router.push(href);
};
