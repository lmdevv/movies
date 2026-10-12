/** Collections of titles, such as box sets imported from Jellyfin or Plex. */
import { Schema } from "effect";

import { CollectionId } from "../ids";
import { TitleCard } from "./catalog";

/** A collection with the titles the profile may see, in collection order. */
export const Collection = Schema.Struct({
  id: CollectionId,
  name: Schema.String,
  titles: Schema.Array(TitleCard),
});

/** A collection. */
export interface Collection extends Schema.Schema.Type<typeof Collection> {}
