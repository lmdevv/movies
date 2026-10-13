/** A collection's poster card: its own poster, else its first title's, linking to its page. */
import type { Collection } from "@movies/contracts/models/collections";
import { PosterCard } from "@movies/ui/components/media-card";
import { Link } from "@tanstack/react-router";

import { artworkUrl } from "@/lib/artwork";
import { plural } from "@/lib/format";

/** The poster a collection shows: its own, else the first of its titles that has one. */
const posterOf = (collection: Collection): string | null =>
  collection.artwork.poster ??
  collection.titles.find((title) => title.artwork.poster !== null)?.artwork.poster ??
  null;

/** A 2:3 card for a collection, with how many titles it holds. */
export function CollectionCard({
  collection,
  className,
}: {
  readonly collection: Collection;
  readonly className?: string;
}) {
  return (
    <PosterCard
      title={collection.name}
      subtitle={plural(collection.titles.length, "title", "titles")}
      image={artworkUrl(posterOf(collection), "poster")}
      className={className}
      render={<Link to="/collection/$collectionId" params={{ collectionId: collection.id }} />}
    />
  );
}
