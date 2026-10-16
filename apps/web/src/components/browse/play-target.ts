import type { EpisodeId, MediaFileId, ProfileId, TitleId } from "@movies/contracts/ids";
import { useCommand } from "@movies/sdk/react";
import { useCallback, useState } from "react";
import { toast } from "sonner";

import { toastFailure } from "@/lib/failure";

/** The `/watch` search: what to play, in which version, and whether from the beginning. */
interface WatchLinkSearch {
  episodeId?: EpisodeId;
  start?: "0";
  version?: MediaFileId;
}

/**
 * The `/watch` search for playing `episodeId` (or the movie), from the beginning when `start`, in
 * `version` when the viewer chose one of several files.
 */
export const watchSearch = (
  episodeId: EpisodeId | undefined,
  start: boolean,
  version?: MediaFileId,
): Readonly<WatchLinkSearch> => {
  const search: WatchLinkSearch = {};

  if (episodeId !== undefined) search.episodeId = episodeId;

  if (start) search.start = "0";

  if (version !== undefined) search.version = version;

  return search;
};

/** A title's My List membership and the way to flip it. */
export interface MyListToggle {
  readonly inList: boolean;
  readonly toggle: () => Promise<void>;
}

/**
 * My List membership with an immediate answer: the toggle flips at once and the subscription
 * confirms it; a failure flips it back and says why.
 */
export const useMyListToggle = (
  profileId: ProfileId,
  titleId: TitleId,
  inMyList: boolean,
  name: string,
): MyListToggle => {
  const add = useCommand("myList.add");
  const remove = useCommand("myList.remove");

  const [optimistic, setOptimistic] = useState<{
    readonly from: boolean;
    readonly to: boolean;
  } | null>(null);

  // The optimistic value holds only until the server's answer moves past what it was based on.
  const inList = optimistic !== null && optimistic.from === inMyList ? optimistic.to : inMyList;

  const toggle = useCallback(async () => {
    const next = !inList;

    setOptimistic({ from: inMyList, to: next });

    try {
      await (next ? add({ profileId, titleId }) : remove({ profileId, titleId }));
      toast.success(next ? `Added ${name} to My List` : `Removed ${name} from My List`);
    } catch (cause) {
      setOptimistic(null);
      toastFailure(cause);
    }
  }, [inList, inMyList, add, remove, profileId, titleId, name]);

  return { inList, toggle };
};
