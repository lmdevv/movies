/**
 * The actions title screens run against the server: My List with an immediate answer, and one-off
 * commands (watched marks, rescans) with a busy state and the line to show when they fail.
 */
import type { ProfileId, TitleId } from "@movies/contracts/ids";
import { useCommand } from "@movies/sdk/react";
import * as Haptics from "expo-haptics";
import { useRef, useState } from "react";

import { describeFailure } from "@/lib/failure";

/** A title's My List membership and the way to flip it. */
export interface MyListToggle {
  readonly inList: boolean;
  /** Resolves true once the server took the change; false when it failed or one was running. */
  readonly toggle: () => Promise<boolean>;
  /** A change is on its way to the server. */
  readonly busy: boolean;
  /** Why the last change failed, until the next one. */
  readonly error: string | null;
}

/**
 * My List membership that flips at once; the live title confirms it, and a failure flips it back
 * and says why.
 */
export const useMyListToggle = (
  profileId: ProfileId,
  titleId: TitleId,
  inMyList: boolean,
): MyListToggle => {
  const add = useCommand("myList.add");
  const remove = useCommand("myList.remove");
  const [error, setError] = useState<string | null>(null);
  // A ref, not state, so a second tap before the next render still sees the first one running.
  const running = useRef(false);
  const [busy, setBusy] = useState(false);

  const [optimistic, setOptimistic] = useState<{
    readonly from: boolean;
    readonly to: boolean;
  } | null>(null);

  // The optimistic value holds only until the server's answer moves past what it was based on.
  const inList = optimistic !== null && optimistic.from === inMyList ? optimistic.to : inMyList;

  const toggle = async (): Promise<boolean> => {
    if (running.current) return false;
    running.current = true;
    setBusy(true);

    const next = !inList;

    void Haptics.selectionAsync();
    setError(null);
    setOptimistic({ from: inMyList, to: next });

    try {
      await (next ? add({ profileId, titleId }) : remove({ profileId, titleId }));

      return true;
    } catch (cause) {
      setOptimistic(null);
      setError(describeFailure(cause));

      return false;
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  return { inList, toggle, busy, error };
};

/** A command run from a button: whether it is running, and why it last failed. */
export interface Runner {
  readonly busy: boolean;
  readonly error: string | null;
  /** Runs `action` unless one is running; resolves true when it succeeded. */
  readonly run: <A>(action: () => Promise<A>) => Promise<boolean>;
}

/** Runs one action at a time and keeps its failure as a short line. */
export const useRunner = (): Runner => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A ref, not state, so a second press before the next render still sees the first one running.
  const running = useRef(false);

  const run = async <A>(action: () => Promise<A>): Promise<boolean> => {
    if (running.current) return false;
    running.current = true;
    setBusy(true);
    setError(null);

    try {
      await action();

      return true;
    } catch (cause) {
      setError(describeFailure(cause));

      return false;
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  return { busy, error, run };
};
