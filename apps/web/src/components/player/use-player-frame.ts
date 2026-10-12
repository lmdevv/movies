/**
 * The player frame's own behavior: controls that hide while the video plays untouched, full screen
 * on the whole frame (or the system player on iPhones), and which phone layout applies.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

/** How long the controls stay after the last pointer move, tap, or key. */
const CONTROLS_IDLE_MS = 3_000;

/**
 * Whether the controls show: always while `hold` is set (paused, a panel open), otherwise until
 * the viewer has been idle over `frame` for three seconds.
 */
export const useControlsVisible = (frame: HTMLElement | null, hold: boolean): boolean => {
  const [awake, setAwake] = useState(true);

  useEffect(() => {
    if (frame === null) return undefined;

    let timer: ReturnType<typeof setTimeout> | undefined;

    const wake = (): void => {
      setAwake(true);
      clearTimeout(timer);
      timer = setTimeout(() => setAwake(false), CONTROLS_IDLE_MS);
    };

    wake();
    frame.addEventListener("pointermove", wake);
    frame.addEventListener("pointerdown", wake);
    window.addEventListener("keydown", wake);

    return () => {
      clearTimeout(timer);
      frame.removeEventListener("pointermove", wake);
      frame.removeEventListener("pointerdown", wake);
      window.removeEventListener("keydown", wake);
    };
  }, [frame]);

  return hold || awake;
};

const subscribeFullscreen = (onChange: () => void): (() => void) => {
  document.addEventListener("fullscreenchange", onChange);

  return () => document.removeEventListener("fullscreenchange", onChange);
};

const readFullscreen = (): boolean => document.fullscreenElement !== null;

/** Full screen as the player uses it. */
export interface Fullscreen {
  /** Whether the page is full screen. */
  readonly fullscreen: boolean;
  /** Enters or leaves full screen. */
  readonly toggle: () => void;
}

/** Whether the page is full screen, and the toggle for `frame` (or the video on iPhones). */
export const useFullscreen = (
  frame: HTMLElement | null,
  video: HTMLVideoElement | null,
): Fullscreen => {
  const fullscreen = useSyncExternalStore(subscribeFullscreen, readFullscreen, readFullscreen);

  const toggle = useCallback(() => {
    if (document.fullscreenElement !== null) {
      void document.exitFullscreen();

      return;
    }

    // iPhone Safari offers no element full screen, only the system player.
    if (frame !== null && document.fullscreenEnabled) {
      void frame.requestFullscreen().catch(() => video?.webkitEnterFullscreen?.());

      return;
    }

    video?.webkitEnterFullscreen?.();
  }, [frame, video]);

  return { fullscreen, toggle };
};

/** A touch screen too small for the desktop player: a phone in either orientation. */
const PHONE_QUERY = "(pointer: coarse) and ((width < 48rem) or (height < 30rem))";

const PORTRAIT_QUERY = "(orientation: portrait)";

const subscribeLayout = (onChange: () => void): (() => void) => {
  const queries = [window.matchMedia(PHONE_QUERY), window.matchMedia(PORTRAIT_QUERY)];

  for (const query of queries) query.addEventListener("change", onChange);

  return () => {
    for (const query of queries) query.removeEventListener("change", onChange);
  };
};

/** Which player layout fits this screen. */
export type PlayerLayout = "desktop" | "phone-landscape" | "phone-portrait";

const readLayout = (): PlayerLayout => {
  if (!window.matchMedia(PHONE_QUERY).matches) return "desktop";

  return window.matchMedia(PORTRAIT_QUERY).matches ? "phone-portrait" : "phone-landscape";
};

/** The player layout for this screen, following rotation. */
export const usePlayerLayout = (): PlayerLayout =>
  useSyncExternalStore(subscribeLayout, readLayout, readLayout);
