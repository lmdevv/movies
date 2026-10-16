import type { ContinueWatchingItem, PersonCard, TitleCard } from "@movies/contracts/models/catalog";
import { episodeCode, facts, progressLabel } from "@movies/sdk/format";
import { useCommand, useCommandQuery } from "@movies/sdk/react";
import type { CommandItem, CommandLeading } from "@movies/ui/lib/command-menu";
import { FilmIcon, PlayIcon, PlusIcon, SearchIcon, TvIcon, UserRoundIcon } from "lucide-react";
import { useMemo } from "react";
import { toast } from "sonner";

import { artworkUrl } from "@/lib/artwork";
import { toastFailure } from "@/lib/failure";
import { useTitleSearch } from "@/lib/use-title-search";

import type { CommandContext, CommandContribution } from "./contribution";

/** Continue watching rows shown when the menu opens. */
const CONTINUE_LIMIT = 3;

/** Title results shown while typing; the search page lists the rest. */
const RESULT_LIMIT = 6;

const posterOf = (title: TitleCard): CommandLeading => {
  const src = artworkUrl(title.artwork.poster, "thumb");

  if (src !== undefined) return { kind: "poster", src };

  return { kind: "icon", icon: title.kind === "movie" ? FilmIcon : TvIcon };
};

const photoOf = (person: PersonCard): CommandLeading => {
  const src = artworkUrl(person.profile, "thumb");

  return src === undefined ? { kind: "icon", icon: UserRoundIcon } : { kind: "poster", src };
};

const continueDetail = (item: ContinueWatchingItem): string =>
  facts(
    item.episode === null ? null : episodeCode(item.episode),
    item.reason === "next" ? "Next" : progressLabel(item.progress),
  );

/**
 * The titles people reach from the menu: Continue watching before anything is typed, title results
 * while typing (filtered server-side for kids profiles), and actions on the top result.
 */
export const useBrowseCommands = (context: CommandContext): CommandContribution => {
  const { navigate, profile, query } = context;
  const continueWatching = useCommandQuery("history.continueWatching", { profileId: profile.id });
  const search = useTitleSearch(profile.id, query);
  const addToList = useCommand("myList.add");

  return useMemo((): CommandContribution => {
    const resumable = continueWatching.status === "success" ? continueWatching.data : [];

    const resume = resumable.slice(0, CONTINUE_LIMIT).map((item): CommandItem => ({
      kind: "action",
      id: `continue:${item.title.id}:${item.episode?.id ?? ""}`,
      title: item.title.name,
      detail: continueDetail(item),
      leading: posterOf(item.title),
      perform: () =>
        navigate({
          to: "/watch/$titleId",
          params: { titleId: item.title.id },
          search: item.episode === null ? {} : { episodeId: item.episode.id },
        }),
    }));

    // The previous results stay while the same query is typed further or shortened, so the list
    // does not flicker. Results of a replaced query would sit first, and Enter would open one.
    const typed = query.trim().toLowerCase();
    const shown = search.query.toLowerCase();

    const matching =
      typed !== "" && shown !== "" && (typed.startsWith(shown) || shown.startsWith(typed));

    const current = matching ? search.results : [];

    const people = (matching ? search.people : []).map((person): CommandItem => ({
      kind: "action",
      id: `person:${person.id}`,
      title: person.name,
      detail: person.knownFor ?? "Person",
      leading: photoOf(person),
      perform: () => navigate({ to: "/person/$personId", params: { personId: person.id } }),
    }));

    const pending: ReadonlyArray<CommandItem> =
      search.loading && current.length === 0
        ? [
            {
              kind: "action",
              id: "search:pending",
              title: "Searching…",
              leading: { kind: "icon", icon: SearchIcon },
              keepOpen: true,
              perform: () => undefined,
            },
          ]
        : [];

    const results = current.slice(0, RESULT_LIMIT).map((title): CommandItem => ({
      kind: "action",
      id: `title:${title.id}`,
      title: title.name,
      detail: facts(title.kind === "movie" ? "Movie" : "Show", title.year),
      leading: posterOf(title),
      perform: () => navigate({ to: "/title/$titleId", params: { titleId: title.id } }),
    }));

    const seeAll: ReadonlyArray<CommandItem> =
      current.length > RESULT_LIMIT
        ? [
            {
              kind: "action",
              id: "search:all",
              title: `See all ${current.length} results`,
              leading: { kind: "icon", icon: SearchIcon },
              perform: () => navigate({ to: "/search", search: { q: query.trim() } }),
            },
          ]
        : [];

    const top = current[0];

    const topActions: ReadonlyArray<CommandItem> =
      top === undefined || !top.available
        ? []
        : [
            {
              kind: "action",
              id: `play-start:${top.id}`,
              title: "Play from the beginning",
              detail: top.name,
              leading: { kind: "icon", icon: PlayIcon },
              perform: () =>
                navigate({
                  to: "/watch/$titleId",
                  params: { titleId: top.id },
                  search: { start: "0" },
                }),
            },
            {
              kind: "action",
              id: `my-list:${top.id}`,
              title: "Add to My List",
              detail: top.name,
              leading: { kind: "icon", icon: PlusIcon },
              perform: async () => {
                try {
                  await addToList({ profileId: profile.id, titleId: top.id });
                  toast.success(`Added ${top.name} to My List`);
                } catch (cause) {
                  toastFailure(cause);
                }
              },
            },
          ];

    return {
      groups: [
        { id: "continue", label: "Continue watching", scope: "browse", items: resume },
        {
          id: "titles",
          label: "Titles",
          scope: "search",
          filter: "none",
          items: [...pending, ...results, ...seeAll],
        },
        { id: "people", label: "People", scope: "search", filter: "none", items: people },
        // Actions on the top result lead "Actions" while searching; their detail is the title, so
        // they match the query. Without them the group keeps its place after "Go to".
        ...(topActions.length === 0
          ? []
          : [{ id: "actions", label: "Actions", items: topActions }]),
      ],
    };
  }, [continueWatching, search, query, navigate, profile.id, addToList]);
};
