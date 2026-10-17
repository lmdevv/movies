/**
 * A title as a row (E01): a 128 × 76 still with the play glyph, the name, and its kind and year.
 * Tapping opens the title; a long press previews it with its actions.
 */
import type { TitleCard } from "@movies/contracts/models/catalog";
import { Link } from "expo-router";
import { Play } from "lucide-react-native";
import { Pressable, View } from "react-native";

import { Icon } from "@/components/ui/icon";
import { Image } from "@/components/ui/image";
import { Text } from "@/components/ui/text";
import { artworkUrl } from "@/lib/artwork";
import { kindFacts } from "@/lib/browse";
import { watchHref } from "@/lib/routes";
import { useServer } from "@/session/connection";

import { useTitleMenu } from "./title-menu";

/** A title row that opens the title. */
export function WideRow({ title }: { readonly title: TitleCard }) {
  const { mediaUrl } = useServer();
  const uri = artworkUrl(mediaUrl, title.artwork.backdrop ?? title.artwork.poster, "card");
  const menu = useTitleMenu(title, watchHref({ titleId: title.id }));
  const detail = kindFacts(title);

  return (
    <Link href={`/title/${title.id}`} asChild>
      <Link.Trigger>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${title.name}, ${detail}`}
          accessibilityHint="Opens the title. Touch and hold for actions."
          className="flex-row items-center gap-3 active:opacity-80"
        >
          <View className="h-19 w-32 overflow-hidden rounded-control bg-surface-raised">
            {uri === undefined ? null : (
              <Image source={{ uri }} contentFit="cover" transition={150} className="size-full" />
            )}
            <View className="absolute bottom-2 left-2">
              <Icon icon={Play} tone="onMedia" size="inline" filled />
            </View>
          </View>
          <View className="flex-1 gap-1">
            <Text variant="labelStrong" numberOfLines={2}>
              {title.name}
            </Text>
            <Text variant="meta" tone="muted" numberOfLines={1}>
              {detail}
            </Text>
          </View>
        </Pressable>
      </Link.Trigger>
      <Link.Preview />
      {menu}
    </Link>
  );
}
