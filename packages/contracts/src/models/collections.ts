/** Collections of titles: TMDB collections, NFO sets, and box sets imported from Jellyfin or Plex. */
import { Schema } from "effect";

import { CollectionId } from "../ids";
import { TitleCard } from "./catalog";

/** A collection with the titles the profile may see, in collection order. */
export const Collection = Schema.Struct({
  id: CollectionId,
  name: Schema.String,
  overview: Schema.NullOr(Schema.String),
  /** Artwork keys, like a title's. */
  artwork: Schema.Struct({
    poster: Schema.NullOr(Schema.String),
    backdrop: Schema.NullOr(Schema.String),
  }),
  titles: Schema.Array(TitleCard),
});

/** A collection. */
export interface Collection extends Schema.Schema.Type<typeof Collection> {}
