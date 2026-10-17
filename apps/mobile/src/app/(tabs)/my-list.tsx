/**
 * C05 · My List: the profile's list in a three-column grid, narrowed to movies or shows by the
 * chips, newest first. Removing a title (long press) offers Undo. Empty, it points to Movies (C06).
 */
import { useCommandQuery } from "@movies/sdk/react";
import { router } from "expo-router";
import { Bookmark } from "lucide-react-native";
import { useState } from "react";
import { View } from "react-native";

import { KindChips } from "@/components/browse/chip";
import { EmptyState } from "@/components/browse/empty-state";
import { PosterGrid } from "@/components/browse/poster-grid";
import { CompactBar, LargeTitle, useCollapse } from "@/components/browse/tab-chrome";
import { UndoBar } from "@/components/browse/undo-bar";
import { Button } from "@/components/ui/button";
import { CalmState } from "@/components/ui/calm-state";
import { Text } from "@/components/ui/text";
import { ofKind, plural } from "@/lib/browse";
import type { KindFilter } from "@/lib/browse";
import { describeFailure } from "@/lib/failure";
import { useActiveProfile } from "@/session/active-profile";

export default function MyList() {
  const { profile } = useActiveProfile();
  const list = useCommandQuery("myList.list", { profileId: profile.id });
  const [kind, setKind] = useState<KindFilter>("all");
  const collapse = useCollapse();

  if (list.status === "loading") return <View className="flex-1 bg-bg" />;

  if (list.status === "error") {
    return (
      <View className="flex-1 bg-bg">
        <CalmState
          title="Couldn't Load My List"
          description={describeFailure(list.error)}
          actions={<Button label="Try Again" onPress={list.retry} />}
        />
      </View>
    );
  }

  const shown = ofKind(list.data, kind);
  const empty = list.data.length === 0;

  return (
    <View className="flex-1 bg-bg">
      <PosterGrid
        titles={shown}
        inside="tabBar"
        onScroll={collapse.onScroll}
        header={
          <View className="gap-4 pb-1">
            <LargeTitle title="My List" />
            {empty ? null : (
              <>
                <View className="px-5">
                  <KindChips kind={kind} onChange={setKind} />
                </View>
                <Text variant="secondary" tone="muted" className="px-5">
                  {plural(shown.length, "Title", "Titles")}
                </Text>
              </>
            )}
          </View>
        }
        empty={
          empty ? (
            <EmptyState
              icon={Bookmark}
              title="Your List Is Empty"
              action={<Button label="Browse Movies" onPress={() => router.navigate("/movies")} />}
            />
          ) : undefined
        }
      />
      <CompactBar title="My List" collapsed={collapse.collapsed} />
      <UndoBar above="tabBar" />
    </View>
  );
}
