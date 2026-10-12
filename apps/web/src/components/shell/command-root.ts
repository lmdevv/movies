import type { CommandItem, CommandPage } from "@movies/ui/lib/command-menu";
import { MonitorIcon, Settings2Icon } from "lucide-react";

import { keymap } from "@/lib/keymap";

import { SECTIONS } from "./sections";

/** Where a "Go to" command can take you. */
export type Destination = "/" | "/movies" | "/shows" | "/my-list" | "/settings";

/** The color themes the menu can switch between. */
export type ThemeChoice = "dark" | "light" | "system";

const THEMES: ReadonlyArray<{ readonly id: ThemeChoice; readonly title: string }> = [
  { id: "dark", title: "Dark" },
  { id: "light", title: "Light" },
  { id: "system", title: "Match system" },
];

/**
 * The command menu's top level for the shell: navigation with its shortcuts, and the theme. Data
 * commands (titles, continue watching, profiles, scans) join once the SDK is wired in.
 */
export function commandRoot(
  navigate: (to: Destination) => void,
  theme: ThemeChoice,
  setTheme: (theme: ThemeChoice) => void,
): CommandPage {
  const goTo: ReadonlyArray<CommandItem> = [
    ...SECTIONS.map((section): CommandItem => ({
      kind: "action",
      id: `go:${section.to}`,
      title: section.label,
      leading: { kind: "icon", icon: section.icon },
      keycaps: keymap.keycaps(section.shortcut),
      perform: () => navigate(section.to),
    })),
    {
      kind: "action",
      id: "go:/settings",
      title: "Settings",
      leading: { kind: "icon", icon: Settings2Icon },
      keycaps: keymap.keycaps("go.settings"),
      perform: () => navigate("/settings"),
    },
  ];

  return {
    id: "root",
    placeholder: "Search or jump to…",
    groups: [
      { id: "go", label: "Go to", items: goTo },
      {
        id: "actions",
        label: "Actions",
        items: [
          {
            kind: "submenu",
            id: "theme",
            title: "Theme…",
            keywords: ["appearance", "dark", "light", "mode"],
            leading: { kind: "icon", icon: MonitorIcon },
            page: {
              id: "theme",
              breadcrumb: "Theme",
              placeholder: "Theme…",
              groups: [
                {
                  id: "themes",
                  items: THEMES.map((choice): CommandItem => ({
                    kind: "action",
                    id: choice.id,
                    title: choice.title,
                    leading: choice.id === theme ? { kind: "check" } : undefined,
                    perform: () => setTheme(choice.id),
                  })),
                },
              ],
            },
          },
        ],
      },
    ],
  };
}
