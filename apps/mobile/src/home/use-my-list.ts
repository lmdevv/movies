/** A title's My List membership with an immediate answer. */
import type { ProfileId, TitleId } from "@movies/contracts/ids";
import { useCommand } from "@movies/sdk/react";
import { useCallback, useState } from "react";

/** A title's My List membership and the way to flip it. */
interface MyListToggle {
  readonly inList: boolean;
  readonly toggle: () => void;
}

/**
 * My List membership that flips at once while the subscription confirms it; a failure flips it
 * back. `inMyList` is the server's answer.
 */
export const useMyList = (
  profileId: ProfileId,
  titleId: TitleId,
  inMyList: boolean,
): MyListToggle => {
  const add = useCommand("myList.add");
  const remove = useCommand("myList.remove");

  const [optimistic, setOptimistic] = useState<{
    readonly from: boolean;
    readonly to: boolean;
  } | null>(null);

  // The optimistic value holds only until the server's answer moves past what it was based on.
  const inList = optimistic !== null && optimistic.from === inMyList ? optimistic.to : inMyList;

  const toggle = useCallback(() => {
    const next = !inList;

    setOptimistic({ from: inMyList, to: next });
    (next ? add({ profileId, titleId }) : remove({ profileId, titleId })).catch(() => {
      setOptimistic(null);
    });
  }, [inList, inMyList, add, remove, profileId, titleId]);

  return { inList, toggle };
};
