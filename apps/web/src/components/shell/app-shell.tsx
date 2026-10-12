import { Avatar } from "@movies/ui/components/avatar";
import { CommandMenu } from "@movies/ui/components/command-menu";
import { CompactTopBar, LargeTitle } from "@movies/ui/components/phone-title";
import { TabBar, TabBarItem, TabBarSearch } from "@movies/ui/components/tab-bar";
import { SearchTrigger, TopBar, TopBarLink } from "@movies/ui/components/top-bar";
import { Wordmark } from "@movies/ui/components/wordmark";
import { moveRowFocus } from "@movies/ui/lib/row-focus";
import { useKeymap } from "@movies/ui/lib/use-keymap";
import { cn } from "@movies/ui/lib/utils";
import { Link, useLocation, useMatches, useNavigate } from "@tanstack/react-router";
import { useTheme } from "@/components/theme-provider";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { keymap, shortcutLabel } from "@/lib/keymap";

import { commandRoot } from "./command-root";
import type { Destination, ThemeChoice } from "./command-root";
import { SECTIONS, sectionOf } from "./sections";

/** How far the page scrolls before bars switch to their scrolled look. */
const SCROLL_THRESHOLD_PX = 48;

/** Whether the window is scrolled past `threshold` pixels. */
function useScrolledPast(threshold: number): boolean {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const update = (): void => setScrolled(window.scrollY > threshold);

    update();
    window.addEventListener("scroll", update, { passive: true });

    return () => window.removeEventListener("scroll", update);
  }, [threshold]);

  return scrolled;
}

const themeChoice = (theme: string | undefined): ThemeChoice =>
  theme === "dark" || theme === "light" ? theme : "system";

/**
 * The signed-in app frame. At `md` and up: the Netflix-style top bar, transparent over a route's
 * hero and solid once scrolled. Below `md`: a large title that hands over to a compact glass bar,
 * and the floating glass tab bar with its search circle. It hosts the command menu and the global
 * keyboard shortcuts.
 *
 * A route opts into the transparent bar over its billboard with `staticData: { hero: true }`.
 *
 * @param profile - The active profile for the avatar; omitted until profiles are wired in.
 */
export function AppShell({
  children,
  profile,
}: {
  readonly children: ReactNode;
  readonly profile?: { readonly name: string; readonly avatar?: string | undefined } | undefined;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });

  const hero = useMatches({
    select: (matches) => matches.some((match) => match.staticData.hero === true),
  });

  const scrolled = useScrolledPast(SCROLL_THRESHOLD_PX);
  const { theme, setTheme } = useTheme();
  const current = sectionOf(pathname);
  const title = current?.label ?? (pathname.startsWith("/settings") ? "Settings" : "");

  const go = (to: Destination): void => {
    void navigate({ to });
  };

  const root = useMemo(
    () => commandRoot((to) => void navigate({ to }), themeChoice(theme), setTheme),
    [navigate, theme, setTheme],
  );

  useKeymap(keymap, {
    "menu.toggle": () => setMenuOpen((open) => !open),
    "search.open": () => setMenuOpen(true),
    "go.home": () => go("/"),
    "go.movies": () => go("/movies"),
    "go.shows": () => go("/shows"),
    "go.my-list": () => go("/my-list"),
    "go.settings": () => go("/settings"),
    "rows.next": () => moveRowFocus(1),
    "rows.previous": () => moveRowFocus(-1),
  });

  const overMedia = hero && !scrolled;

  const avatar =
    profile === undefined ? null : <Avatar name={profile.name} image={profile.avatar} size="sm" />;

  return (
    <div className="min-h-svh bg-page text-text">
      <div
        className={cn(
          "fixed inset-x-0 top-0 z-40 hidden px-16 transition-colors duration-200 md:block",
          overMedia ? "bg-linear-to-b from-dark-bg/55 to-transparent" : "bg-page",
        )}
      >
        <TopBar
          overMedia={overMedia}
          className="mx-auto max-w-content"
          brand={
            <Link to="/" aria-label="[movies] home" className="rounded-xs">
              <Wordmark />
            </Link>
          }
          nav={SECTIONS.map((section) => (
            <TopBarLink
              key={section.to}
              active={current?.to === section.to}
              render={<Link to={section.to} />}
            >
              {section.label}
            </TopBarLink>
          ))}
          actions={
            <>
              <SearchTrigger
                keycaps={shortcutLabel("menu.toggle")}
                aria-keyshortcuts="Meta+K Control+K"
                onClick={() => setMenuOpen(true)}
              />
              {avatar}
            </>
          }
        />
      </div>

      <CompactTopBar
        title={title}
        visible={scrolled}
        className="fixed inset-x-0 top-0 z-40 md:hidden"
        trailing={
          profile === undefined ? undefined : (
            <Avatar name={profile.name} image={profile.avatar} size="xs" round />
          )
        }
      />

      <main className={cn("pb-32 md:pb-20", !hero && "md:pt-17")}>
        {title === "" ? null : (
          <LargeTitle
            title={title}
            className="pt-[max(env(safe-area-inset-top),--spacing(4))] md:hidden"
            trailing={
              profile === undefined ? undefined : (
                <Avatar name={profile.name} image={profile.avatar} round />
              )
            }
          />
        )}
        {children}
      </main>

      <TabBar
        minimized={scrolled}
        className="fixed inset-x-4 bottom-[max(env(safe-area-inset-bottom),--spacing(6))] z-40 md:hidden"
        search={<TabBarSearch onClick={() => setMenuOpen(true)} />}
      >
        {SECTIONS.map((section) => (
          <TabBarItem
            key={section.to}
            label={section.label}
            icon={<section.icon strokeWidth={1.75} aria-hidden />}
            active={current?.to === section.to}
            render={<Link to={section.to} />}
          />
        ))}
      </TabBar>

      <CommandMenu open={menuOpen} onOpenChange={setMenuOpen} root={root} />
    </div>
  );
}
