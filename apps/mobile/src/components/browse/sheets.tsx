/**
 * The Movies and Shows sheets: Sort (C14) lists the server's orders with the current one marked,
 * Filter (C15) narrows by library and genre and says how many titles that leaves, and Genres lists
 * every genre of the kind with its count, opening the genre's page.
 */
import type { LibraryId } from "@movies/contracts/ids";
import { useCommandQuery } from "@movies/sdk/react";
import { router } from "expo-router";
import { X } from "lucide-react-native";
import { useState } from "react";
import { ScrollView, View } from "react-native";

import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { ListRow } from "@/components/ui/list-row";
import { Text } from "@/components/ui/text";
import { DEFAULT_FILTERS, SORT_OPTIONS, kindLabel, librariesFor, listArgs } from "@/lib/browse";
import type { BrowseFilters } from "@/lib/browse";
import { useActiveProfile } from "@/session/active-profile";

import { Chip } from "./chip";
import { useTabFilters } from "./filters";

/** Genre chips the Filter sheet offers after All, most common first. */
const FILTER_GENRES = 8;

/** Titles the Filter sheet counts before it says `100+`. */
const COUNT_LIMIT = 100;

/** A sheet's 22pt heading with the close button. */
function SheetHeader({ title }: { readonly title: string }) {
  return (
    <View className="flex-row items-center gap-3">
      <Text variant="heading" className="flex-1" accessibilityRole="header" numberOfLines={1}>
        {title}
      </Text>
      <IconButton icon={X} label="Close" onPress={() => router.back()} />
    </View>
  );
}

/** C14 · Sort: Recently Added, Title, or Release Date. */
export function SortSheet() {
  const { kind, filters, setFilters } = useTabFilters();

  return (
    <View className="gap-4 px-5 pt-6 pb-8">
      <SheetHeader title={`Sort ${kindLabel(kind)}`} />
      <View>
        {SORT_OPTIONS.map((option) =>
          option.sort === filters.sort ? (
            <ListRow
              key={option.sort}
              title={option.label}
              detail="Selected"
              onPress={() => router.back()}
            />
          ) : (
            <ListRow
              key={option.sort}
              title={option.label}
              onPress={() => {
                setFilters({ ...filters, sort: option.sort });
                router.back();
              }}
            />
          ),
        )}
      </View>
    </View>
  );
}

/** A labeled row of chips in the Filter sheet. */
function ChipGroup<Value>({
  label,
  options,
  value,
  onChange,
}: {
  readonly label: string;
  readonly options: ReadonlyArray<{ readonly value: Value; readonly label: string }>;
  readonly value: Value;
  readonly onChange: (value: Value) => void;
}) {
  return (
    <View className="gap-3">
      <Text variant="label" tone="muted" accessibilityRole="header">
        {label}
      </Text>
      <View className="flex-row flex-wrap gap-2">
        {options.map((option) => (
          <Chip
            key={option.label}
            label={option.label}
            selected={option.value === value}
            accessibilityLabel={`${label}: ${option.label}`}
            onPress={() => onChange(option.value)}
          />
        ))}
      </View>
    </View>
  );
}

/** C15 · Filter: library and genre, applied together with Show. */
export function FilterSheet() {
  const { profile } = useActiveProfile();
  const { kind, filters, setFilters } = useTabFilters();
  const [pending, setPending] = useState<BrowseFilters>(filters);
  const libraries = useCommandQuery("libraries.list", {});
  const genres = useCommandQuery("titles.genres", { profileId: profile.id, kind });

  const count = useCommandQuery(
    "titles.list",
    listArgs(profile.id, kind, pending, null, COUNT_LIMIT),
  );

  const noun = kindLabel(kind);

  const libraryOptions: ReadonlyArray<{
    readonly value: LibraryId | null;
    readonly label: string;
  }> = [
    { value: null, label: "All" },
    ...(libraries.status === "success" ? librariesFor(libraries.data, kind) : []).map(
      (library) => ({
        value: library.id,
        label: library.name,
      }),
    ),
  ];

  const genreNames = genres.status === "success" ? genres.data.slice(0, FILTER_GENRES) : [];

  // A genre chosen elsewhere stays offered even when it is not among the most common.
  const genreOptions: ReadonlyArray<{ readonly value: string | null; readonly label: string }> = [
    { value: null, label: "All" },
    ...genreNames.map((genre) => ({ value: genre.name, label: genre.name })),
    ...(pending.genre === null || genreNames.some((genre) => genre.name === pending.genre)
      ? []
      : [{ value: pending.genre, label: pending.genre }]),
  ];

  const show =
    count.status === "success"
      ? `Show ${count.data.nextCursor === null ? count.data.items.length : `${COUNT_LIMIT}+`} ${noun}`
      : `Show ${noun}`;

  return (
    <View className="gap-4 px-5 pt-6 pb-8">
      <SheetHeader title="Filter" />
      {libraryOptions.length > 2 ? (
        <ChipGroup
          label="Library"
          options={libraryOptions}
          value={pending.libraryId}
          onChange={(libraryId) => setPending({ ...pending, libraryId })}
        />
      ) : null}
      <ChipGroup
        label="Genre"
        options={genreOptions}
        value={pending.genre}
        onChange={(genre) => setPending({ ...pending, genre })}
      />
      <View className="gap-1 pt-2">
        <Button
          label={show}
          disabled={
            count.status === "success" &&
            count.data.items.length === 0 &&
            count.data.nextCursor === null
          }
          onPress={() => {
            setFilters(pending);
            router.back();
          }}
        />
        <Button
          label="Reset Filters"
          variant="plain"
          onPress={() => setPending({ ...DEFAULT_FILTERS, sort: pending.sort })}
        />
      </View>
    </View>
  );
}

/** Every genre of the tab's kind with its count; choosing one opens its page. */
export function GenresSheet() {
  const { profile } = useActiveProfile();
  const { kind } = useTabFilters();
  const genres = useCommandQuery("titles.genres", { profileId: profile.id, kind });

  return (
    <ScrollView contentContainerClassName="gap-4 px-5 pt-6 pb-8">
      <SheetHeader title="Genres" />
      <View>
        {(genres.status === "success" ? genres.data : []).map((genre) => (
          <ListRow
            key={genre.name}
            title={genre.name}
            detail={String(genre.count)}
            onPress={() => {
              router.back();
              router.push(`/genre/${encodeURIComponent(genre.name)}?kind=${kind}`);
            }}
          />
        ))}
      </View>
    </ScrollView>
  );
}
