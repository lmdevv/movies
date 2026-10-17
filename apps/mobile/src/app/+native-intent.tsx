/**
 * Incoming links. Invite links (`movies://invite?…`) are not screens: the invite handler in the
 * root layout reads them, so routing keeps the current screen, or the first one at launch.
 */
import { parseInviteLink } from "@/lib/invite-link";

export const redirectSystemPath = ({
  path,
  initial,
}: {
  readonly path: string;
  readonly initial: boolean;
}): string | null => {
  if (parseInviteLink(path) === null) return path;

  return initial ? "/" : null;
};
