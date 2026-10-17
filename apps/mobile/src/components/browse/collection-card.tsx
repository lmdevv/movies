/**
 * A collection as a wide card: in Home's row (C02, 264 × 148 with the name under it) or on the
 * Collections page (C07, full width × 180 with a 28pt name and the title count).
 */
import type { Collection } from "@movies/contracts/models/collections";
import { router } from "expo-router";
import { Pressable, View } from "react-native";

import { Image } from "@/components/ui/image";
import { Text } from "@/components/ui/text";
import { artworkUrl } from "@/lib/artwork";
import { titleCount } from "@/lib/browse";
import { useServer } from "@/session/connection";

/** The collection's own backdrop, else the first of its titles that has one. */
const backdropOf = (collection: Collection): string | null =>
  collection.artwork.backdrop ??
  collection.titles.find((title) => title.artwork.backdrop !== null)?.artwork.backdrop ??
  null;

/** A tappable collection card that opens the collection. */
export function CollectionCard({
  collection,
  size,
}: {
  readonly collection: Collection;
  readonly size: "rail" | "wide";
}) {
  const { mediaUrl } = useServer();
  const uri = artworkUrl(mediaUrl, backdropOf(collection), "card");
  const count = titleCount(collection.titles);
  const rail = size === "rail";

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${collection.name}, ${count}`}
      onPress={() => router.push(`/collection/${collection.id}`)}
      className={`${rail ? "w-66 gap-1.5" : "w-full gap-2"} active:opacity-80`}
    >
      <View
        className={`overflow-hidden bg-surface-raised ${
          rail ? "h-37 rounded-control" : "h-45 rounded-card"
        }`}
      >
        {uri === undefined ? null : (
          <Image source={{ uri }} contentFit="cover" transition={150} className="size-full" />
        )}
      </View>
      <Text variant={rail ? "label" : "title"} numberOfLines={rail ? 1 : 2}>
        {collection.name}
      </Text>
      {rail ? null : (
        <Text variant="secondary" tone="muted">
          {count}
        </Text>
      )}
    </Pressable>
  );
}
