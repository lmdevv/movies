/**
 * The body of the title screens' native form sheets (D05 Seasons, D06 Choose Version, D07 Episode
 * Actions, D10 title actions): a 22pt heading with a close button, an optional muted line, then
 * 56pt rows 16pt apart on the raised surface. iOS draws the grabber and sizes the sheet to fit.
 */
import { router } from "expo-router";
import { X } from "lucide-react-native";
import { useRef } from "react";
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
  const exit = useSheetExit();

  return (
    <View className="gap-4 bg-surface-raised px-5 pt-6 pb-4">
      <View className="flex-row items-center gap-3">
        <Text variant="heading" className="flex-1" numberOfLines={2} accessibilityRole="header">
          {title}
        </Text>
        <IconButton icon={X} label="Close" variant="plain" onPress={exit.close} />
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

/** The ways a sheet ends, each taking effect once however often it is pressed. */
export interface SheetExit {
  /** Closes the sheet. */
  readonly close: () => void;
  /** Closes the sheet, then opens `href` from the screen under it, such as the player. */
  readonly leaveFor: (href: string) => void;
  /** Puts the sheet at `href` in place of this one, such as Choose Version. */
  readonly switchTo: (href: string) => void;
}

/**
 * A sheet's exits. Only the first one runs: a double tap would otherwise go back twice and also
 * close the title page under the sheet.
 */
export const useSheetExit = (): SheetExit => {
  const left = useRef(false);

  const once = (go: () => void): void => {
    if (left.current) return;
    left.current = true;
    go();
  };

  return {
    close: () => once(() => router.back()),
    leaveFor: (href) =>
      once(() => {
        router.back();
        router.push(href);
      }),
    switchTo: (href) => once(() => router.replace(href)),
  };
};
