/** Failures as toasts; `@movies/sdk/failure` words them. */
import { describeFailure } from "@movies/sdk/failure";
import { toast } from "sonner";

/** Shows a failure as an error toast. */
export const toastFailure = (cause: unknown): void => {
  toast.error(describeFailure(cause));
};
