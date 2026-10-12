import { Predicate } from "effect";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";

/**
 * The sentence to show for a failed command. Server failures carry wording written for people;
 * connection and contract failures get a fixed sentence instead of their diagnostic text.
 */
export const describeFailure = (cause: unknown): string => {
  if (Predicate.isTagged(cause, "TransportError")) return "Can’t reach the server. Try again.";

  if (Predicate.isTagged(cause, "ProtocolError")) {
    return "The server answered in a way this page doesn’t understand. Reload and try again.";
  }

  if (Predicate.hasProperty(cause, "message") && Predicate.isString(cause.message)) {
    return cause.message;
  }

  return "Something went wrong. Try again.";
};

/** Options for {@link useAction}. */
export interface ActionOptions<Result> {
  /** The toast after success, built from the result. */
  readonly success?: (result: Result) => string;
  /** Show failures inline instead of as a toast; the hook still reports them through `error`. */
  readonly quiet?: boolean;
  /** Runs after a success, such as closing the dialog that started the action. */
  readonly onSuccess?: (result: Result) => void;
}

/** What {@link useAction} returns. */
export interface ActionState<Args extends ReadonlyArray<unknown>, Result> {
  /** Runs the action; resolves with its result, or `undefined` after a failure. */
  readonly run: (...args: Args) => Promise<Result | undefined>;
  readonly pending: boolean;
  /** The last failure's sentence, cleared when the action runs again. */
  readonly error: string | undefined;
  readonly reset: () => void;
}

/**
 * Wraps a command call with the feedback every action needs: `pending` while it runs, then an
 * optional success toast, and the failure as a toast (or inline with `quiet`).
 */
export const useAction = <Args extends ReadonlyArray<unknown>, Result>(
  action: (...args: Args) => Promise<Result>,
  options: ActionOptions<Result> = {},
): ActionState<Args, Result> => {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const latest = useRef({ action, options });

  latest.current = { action, options };

  const run = useCallback(async (...args: Args): Promise<Result | undefined> => {
    setPending(true);
    setError(undefined);

    try {
      const result = await latest.current.action(...args);
      const success = latest.current.options.success;

      if (success !== undefined) toast.success(success(result));

      latest.current.options.onSuccess?.(result);

      return result;
    } catch (cause) {
      const message = describeFailure(cause);

      setError(message);

      if (latest.current.options.quiet !== true) toast.error(message);

      return undefined;
    } finally {
      setPending(false);
    }
  }, []);

  const reset = useCallback(() => setError(undefined), []);

  return { run, pending, error, reset };
};
