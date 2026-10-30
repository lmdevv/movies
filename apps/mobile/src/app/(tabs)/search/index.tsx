import type { PersonCard, TitleCard } from "@movies/contracts/models/catalog";
import { useCommandQuery } from "@movies/sdk/react";
import { Stack, router, useFocusEffect, useNavigation } from "expo-router";
import { Search as SearchIcon } from "lucide-react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, ScrollView, useWindowDimensions, View } from "react-native";
import type { SearchBarCommands } from "react-native-screens";

import { Chip, KindChips } from "@/components/browse/chip";
import { EmptyState } from "@/components/browse/empty-state";
import { PersonRow } from "@/components/browse/person-row";
import { useOnSearchActivate } from "@/components/browse/search-activation";
import { WideRow } from "@/components/browse/wide-row";
import { TitlePoster } from "@/components/title-poster";
import { Button } from "@/components/ui/button";
import { CalmState } from "@/components/ui/calm-state";
import { Text } from "@/components/ui/text";
import { GRID_SPACING, gridCells, gridColumns, popularTitles } from "@/lib/browse";
import type { KindFilter } from "@/lib/browse";
import { describeFailure } from "@/lib/failure";
import { useWidthClass } from "@/lib/use-width-class";
import { useThemeColor } from "@/lib/theme-color";
import { useActiveProfile } from "@/session/active-profile";

const DEBOUNCE_MS = 250;

const RESULT_LIMIT = 30;

const EXPLORE_GENRES = 6;

const EXPLORE_TITLES = 8;

const useSettled = (text: string): string => {
  const [settled, setSettled] = useState(text.trim());

  useEffect(() => {
    const timer = setTimeout(() => setSettled(text.trim()), DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [text]);

  return settled;
};

export default function Search() {
  const { profile } = useActiveProfile();
  const accent = useThemeColor("--color-accent");
  const search = useRef<SearchBarCommands>(null);
  const [text, setText] = useState("");
  const query = useSettled(text);

  const navigation = useNavigation();
  const focusOnArrival = useRef(false);

  useOnSearchActivate(
    useCallback(() => {
      if (navigation.isFocused()) search.current?.focus();
      else focusOnArrival.current = true;
    }, [navigation]),
  );

  useFocusEffect(
    useCallback(() => {
      if (!focusOnArrival.current) return;

      focusOnArrival.current = false;
      search.current?.focus();
    }, []),
  );

  const clear = () => {
    search.current?.clearText();
    setText("");
  };

  return (
    <>
      <Stack.SearchBar
        ref={search}
        placeholder="Movies, shows, people"
        tintColor={accent}
        hideWhenScrolling={false}
        hideNavigationBar={false}
        autoCapitalize="none"
        onChangeText={(event) => setText(event.nativeEvent.text)}
        onCancelButtonPress={() => setText("")}
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        className="flex-1 bg-bg"
        contentContainerClassName="gap-6 px-5 pt-2 regular:px-8 wide:px-12"
      >
        {query === "" ? (
          <Explore />
        ) : (
          <Results key={query} query={query} showPeople={!profile.kids} onClear={clear} />
        )}
      </ScrollView>
    </>
  );
}

function Explore() {
  const { profile } = useActiveProfile();
  const genres = useCommandQuery("titles.genres", { profileId: profile.id });
  const home = useCommandQuery("titles.home", { profileId: profile.id });

  const popular = home.status === "success" ? popularTitles(home.data, EXPLORE_TITLES) : [];

  return (
    <>
      {genres.status === "success" && genres.data.length > 0 ? (
        <View className="gap-4">
          <Text variant="heading" accessibilityRole="header">
            Explore
          </Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            className="-mx-5 regular:-mx-8 wide:-mx-12"
            contentContainerClassName="gap-2 px-5 regular:px-8 wide:px-12"
          >
            {genres.data.slice(0, EXPLORE_GENRES).map((genre, index) => (
              <Chip
                key={genre.name}
                label={genre.name}
                prominent={index === 0}
                onPress={() => router.push(`/genre/${encodeURIComponent(genre.name)}`)}
              />
            ))}
          </ScrollView>
        </View>
      ) : null}
      {popular.length > 0 ? (
        <View className="gap-4">
          <Text variant="heading" accessibilityRole="header">
            Popular in Your Library
          </Text>
          {popular.map((title) => (
            <WideRow key={title.id} title={title} />
          ))}
        </View>
      ) : null}
    </>
  );
}

function Results({
  query,
  showPeople,
  onClear,
}: {
  readonly query: string;
  readonly showPeople: boolean;
  readonly onClear: () => void;
}) {
  const { profile } = useActiveProfile();
  const [kind, setKind] = useState<KindFilter>("all");

  const titles = useCommandQuery("titles.search", {
    profileId: profile.id,
    query,
    limit: RESULT_LIMIT,
  });

  const people = useCommandQuery(
    "people.search",
    showPeople ? { profileId: profile.id, query, limit: 10 } : "skip",
  );

  if (titles.status === "error") {
    return (
      <View className="h-96">
        <CalmState
          title="Couldn't Search"
          description={describeFailure(titles.error)}
          actions={<Button label="Try Again" onPress={titles.retry} />}
        />
      </View>
    );
  }

  if (titles.status === "loading") {
    return <ActivityIndicator className="py-10" colorClassName="accent-text-muted" />;
  }

  const found: ReadonlyArray<PersonCard> = people.status === "success" ? people.data : [];
  const noPeople = !showPeople || (people.status === "success" && people.data.length === 0);

  if (titles.data.length === 0 && noPeople) {
    return (
      <EmptyState
        icon={SearchIcon}
        title={`No results for “${query}”`}
        placement="results"
        action={<Button label="Clear Search" variant="secondary" onPress={onClear} />}
      />
    );
  }

  if (!showPeople) return <ResultGrid title="Top Results" titles={titles.data} />;

  const movies = titles.data.filter((title) => title.kind === "movie");
  const shows = titles.data.filter((title) => title.kind === "show");

  return (
    <>
      {titles.data.length > 0 ? <KindChips kind={kind} onChange={setKind} /> : null}
      {kind === "show" ? null : <ResultGrid title="Movies" titles={movies} />}
      {kind === "movie" ? null : <ResultGrid title="Shows" titles={shows} />}
      {kind === "all" && people.status === "error" ? (
        <View className="gap-2">
          <Text variant="heading" accessibilityRole="header">
            People
          </Text>
          <Text variant="meta" tone="danger">
            {describeFailure(people.error)}
          </Text>
          <Button label="Try Again" variant="secondary" onPress={people.retry} />
        </View>
      ) : null}
      {kind === "all" && found.length > 0 ? (
        <View className="gap-2">
          <Text variant="heading" accessibilityRole="header">
            People
          </Text>
          {found.map((person) => (
            <PersonRow key={person.id} person={person} />
          ))}
        </View>
      ) : null}
    </>
  );
}

function ResultGrid({
  title,
  titles,
}: {
  readonly title: string;
  readonly titles: ReadonlyArray<TitleCard>;
}) {
  const { width } = useWindowDimensions();
  const spacing = GRID_SPACING[useWidthClass()];

  if (titles.length === 0) return null;

  const columns = gridColumns(width, spacing);
  const cells = gridCells(titles, columns);

  const rows = Array.from({ length: cells.length / columns }, (_, row) =>
    cells.slice(row * columns, (row + 1) * columns),
  );

  return (
    <View className="gap-4">
      <Text variant="heading" accessibilityRole="header">
        {title}
      </Text>
      {rows.map((row) => (
        <View
          key={row.map((cell) => (cell.kind === "title" ? cell.title.id : cell.key)).join()}
          className="flex-row"
          style={{ gap: spacing.gap }}
        >
          {row.map((cell) =>
            cell.kind === "title" ? (
              <TitlePoster
                key={cell.title.id}
                title={cell.title}
                caption="grid"
                widthClassName="flex-1"
              />
            ) : (
              <View key={cell.key} className="flex-1" />
            ),
          )}
        </View>
      ))}
    </View>
  );
}
