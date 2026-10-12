/**
 * The command menu's root list, collected from every feature in `src/commands/`.
 *
 * To add commands for a feature, create `src/commands/<feature>.ts` exporting a hook
 * `use<Feature>Commands(context: CommandContext): CommandContribution`, then call it below in the
 * place its groups should appear. Groups with the same `id` merge, so a feature can add rows to
 * "Actions" (`id: "actions"`) or "Go to" (`id: "go"`).
 */
import type { CommandPage } from "@movies/ui/lib/command-menu";
import { useMemo } from "react";

import { useBrowseCommands } from "./browse";
import type { CommandContext } from "./contribution";
import { mergeContributions } from "./contribution";
import { useLibraryCommands } from "./library";
import { useNavigationCommands } from "./navigation";
import { usePreferenceCommands } from "./preferences";
import { useProfileCommands } from "./profiles";

export type { CommandContext } from "./contribution";

export { SWITCH_PROFILE_COMMAND } from "./profiles";

/** Every contribution merged into the menu's root page, in menu order. */
export const useCommandRoot = (context: CommandContext): CommandPage => {
  const browse = useBrowseCommands(context);
  const navigation = useNavigationCommands(context);
  const profiles = useProfileCommands(context);
  const preferences = usePreferenceCommands();
  const library = useLibraryCommands(context);

  return useMemo((): CommandPage => {
    const { groups, fallback } = mergeContributions([
      browse,
      navigation,
      profiles,
      library,
      preferences,
    ]);

    return { id: "root", placeholder: "Search or jump to…", groups, fallback: () => fallback };
  }, [browse, navigation, profiles, preferences, library]);
};
