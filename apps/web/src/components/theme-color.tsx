import { useSyncExternalStore } from "react";

/**
 * Tailwind's `md` breakpoint, where dark pages move from `dark-bg` to `dark-surface` (see the
 * `.dark` rules in the UI kit's globals.css).
 */
const DESKTOP = "(width >= 48rem)";

/** Calls `onChange` when the theme class on `<html>` or the side of the desktop breakpoint changes. */
const subscribe = (onChange: () => void): (() => void) => {
  const observer = new MutationObserver(onChange);
  const desktop = window.matchMedia(DESKTOP);

  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  desktop.addEventListener("change", onChange);

  return () => {
    observer.disconnect();
    desktop.removeEventListener("change", onChange);
  };
};

/** The page canvas color of the theme in use, resolved from the `--color-page` token. */
const pageColor = (): string =>
  getComputedStyle(document.documentElement).getPropertyValue("--color-page").trim();

/**
 * The browser's theme color (a phone's status bar, an installed app's title bar), kept on the page
 * color of whichever theme is showing: the saved choice, or the system's when it follows the system.
 */
export function ThemeColor() {
  const color = useSyncExternalStore(subscribe, pageColor);

  return color === "" ? null : <meta name="theme-color" content={color} />;
}
