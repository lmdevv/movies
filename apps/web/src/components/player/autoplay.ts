/** Where the video sits while the next episode waits, on screens wide enough for both. */
export const AUTOPLAY_VIDEO_FRAME =
  "md:inset-auto md:top-49 md:left-16 md:aspect-video md:h-auto md:w-1/2 md:overflow-hidden md:rounded-card";

/** The countdown before the next episode plays, and how often it ticks. */
export const AUTOPLAY_COUNTDOWN = { totalMs: 10_000, stepMs: 1_000 } as const;
