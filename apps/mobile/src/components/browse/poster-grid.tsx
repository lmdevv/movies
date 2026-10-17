/**
 * A three-column poster grid (C03–C05, C08, C09, C11): the posters with 13pt names under a header,
 * blanks that keep the last row's posters at a third of the width, and room for the tab bar or the
 * home indicator.
 */
import type { TitleCard } from "@movies/contracts/models/catalog";
import type { ReactElement } from "react";
import { ActivityIndicator, FlatList, View } from "react-native";
import type { NativeScrollEvent, NativeSyntheticEvent } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { gridCells } from "@/lib/browse";
import { describeFailure } from "@/lib/failure";

import { TitlePoster } from "../title-poster";
import { TAB_BAR_CLEARANCE } from "./layout";
import type { TitlePages } from "./title-pages";

/** Props for `PosterGrid`. */
export interface PosterGridProps {
  readonly titles: ReadonlyArray<TitleCard>;
  readonly header?: ReactElement | undefined;
  readonly footer?: ReactElement | undefined;
  readonly empty?: ReactElement | undefined;
  readonly onEndReached?: (() => void) | undefined;
  readonly onScroll?: ((event: NativeSyntheticEvent<NativeScrollEvent>) => void) | undefined;
  /**
   * `tabBar` for a tab's content, which starts under the status bar and clears the floating tab
   * bar; `screen` under a pushed screen's header.
   */
  readonly inside?: "tabBar" | "screen";
}

/** A scrolling grid of posters. */
export function PosterGrid({
  titles,
  header,
  footer,
  empty,
  onEndReached,
  onScroll,
  inside = "screen",
}: PosterGridProps) {
  const insets = useSafeAreaInsets();
  const tab = inside === "tabBar";

  return (
    <FlatList
      data={gridCells(titles)}
      numColumns={3}
      keyExtractor={(cell) => (cell.kind === "title" ? cell.title.id : cell.key)}
      renderItem={({ item }) =>
        item.kind === "title" ? (
          <TitlePoster title={item.title} caption="grid" widthClassName="flex-1" />
        ) : (
          <View className="flex-1" />
        )
      }
      ListHeaderComponent={header}
      ListFooterComponent={footer}
      ListEmptyComponent={empty}
      ListFooterComponentClassName="pb-6"
      columnWrapperClassName="gap-2 px-5"
      contentContainerClassName={tab ? "gap-5" : "gap-5 pt-2"}
      contentContainerStyle={{ paddingBottom: insets.bottom + (tab ? TAB_BAR_CLEARANCE : 0) }}
      contentInsetAdjustmentBehavior={tab ? "never" : "automatic"}
      onEndReached={onEndReached}
      onEndReachedThreshold={1}
      onScroll={onScroll}
      scrollEventThrottle={16}
    />
  );
}

/**
 * The end of a paged grid: a spinner while more pages load, or why the next page failed with Try
 * Again once some titles are on screen.
 */
export function PagingFooter({ pages }: { readonly pages: TitlePages }) {
  if (pages.failure !== null && pages.titles.length > 0) {
    return (
      <View className="items-center gap-3 px-5 pt-4">
        <Text variant="meta" tone="danger" className="text-center">
          {describeFailure(pages.failure.cause)}
        </Text>
        <Button
          label="Try Again"
          variant="secondary"
          className="self-stretch"
          onPress={pages.retry}
        />
      </View>
    );
  }

  if (pages.loaded && !pages.complete) {
    return <ActivityIndicator className="py-6" colorClassName="accent-text-muted" />;
  }

  return <View />;
}
