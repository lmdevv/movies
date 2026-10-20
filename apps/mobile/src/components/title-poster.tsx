/**
 * A title's poster in a rail or grid (C01–C11): 2:3 artwork with the control radius and the name
 * under it, or a 264 × 148 still in Home's My List row (C02). Tapping opens the title; a long press
 * previews it with the title's actions (C16).
 */
import type { TitleCard } from "@movies/contracts/models/catalog";
import { Link } from "expo-router";
import { Pressable, View } from "react-native";

import { artworkUrl } from "@/lib/artwork";
import { watchHref } from "@/lib/routes";
import { useServer } from "@/session/connection";

import { useTitleMenu } from "./browse/title-menu";
import { Image } from "./ui/image";
import { Text } from "./ui/text";

/** Props for `TitlePoster`. */
export interface TitlePosterProps {
  readonly title: TitleCard;
  /**
   * The name under the artwork: 15pt in rails (`rail`), 13pt in three-column grids (`grid`), or
   * none.
   */
  readonly caption?: "rail" | "grid" | "none";
  /** Tailwind width class, such as `w-28`; grids pass `flex-1`. Stills are always 264pt wide. */
  readonly widthClassName?: string;
  /** The 2:3 poster, or the title's wide still. */
  readonly artwork?: "poster" | "still";
}

/** A poster that opens the title, with its actions on a long press. */
export function TitlePoster({
  title,
  caption = "rail",
  widthClassName = "w-28",
  artwork = "poster",
}: TitlePosterProps) {
  const { mediaUrl } = useServer();
  const still = artwork === "still";

  const uri = still
    ? artworkUrl(mediaUrl, title.artwork.backdrop ?? title.artwork.poster, "card")
    : artworkUrl(mediaUrl, title.artwork.poster, "poster");

  const menu = useTitleMenu(title, watchHref({ titleId: title.id }));

  return (
    <Link href={`/title/${title.id}`} asChild>
      <Link.Trigger>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={title.name}
          accessibilityHint="Opens the title. Touch and hold for actions."
          className={`${still ? "w-66" : widthClassName} gap-1.5 active:opacity-80`}
        >
          <View
            className={`${still ? "h-37" : "aspect-2/3"} w-full overflow-hidden rounded-control bg-surface-raised`}
          >
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
          {caption === "none" ? null : (
            <Text variant={caption === "rail" ? "label" : "metaStrong"} numberOfLines={2}>
              {title.name}
            </Text>
          )}
        </Pressable>
      </Link.Trigger>
      <Link.Preview />
      {menu}
    </Link>
  );
}
