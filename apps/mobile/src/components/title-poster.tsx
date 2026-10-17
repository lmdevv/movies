/** A title's poster in a rail or grid: 2:3 artwork with the 4pt poster radius, tapping opens it. */
import type { TitleCard } from "@movies/contracts/models/catalog";
import { router } from "expo-router";
import { Pressable, View } from "react-native";

import { artworkUrl } from "@/lib/artwork";
import { useServer } from "@/session/connection";

import { Image } from "./ui/image";
import { Text } from "./ui/text";

/** Props for `TitlePoster`. */
export interface TitlePosterProps {
  readonly title: TitleCard;
  /** Tailwind width class, such as `w-28`. */
  readonly widthClassName?: string;
}

/** A tappable poster that opens the title. */
export function TitlePoster({ title, widthClassName = "w-28" }: TitlePosterProps) {
  const { mediaUrl } = useServer();
  const uri = artworkUrl(mediaUrl, title.artwork.poster, "poster");

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title.name}
      onPress={() => router.push(`/title/${title.id}`)}
      className={`${widthClassName} active:opacity-80`}
    >
      <View className="aspect-2/3 w-full overflow-hidden rounded-poster bg-surface-raised">
        {uri === undefined ? (
          <View className="flex-1 items-center justify-center p-2">
            <Text variant="caption" tone="muted" className="text-center" numberOfLines={3}>
              {title.name}
            </Text>
          </View>
        ) : (
          <Image source={{ uri }} contentFit="cover" transition={150} className="size-full" />
        )}
      </View>
    </Pressable>
  );
}
