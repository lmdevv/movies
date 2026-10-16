/**
 * Paper 07 · 05 Autoplay next: near the end of an episode the video shrinks into a card on the
 * left while the next episode waits on the right with a countdown. Next episode plays it now;
 * Watch credits cancels the countdown and returns to the full frame.
 */
import type { Episode } from "@movies/contracts/models/catalog";
import { episodeCode, formatRuntime } from "@movies/sdk/format";
import { Button } from "@movies/ui/components/button";
import { ProgressRing } from "@movies/ui/components/progress-ring";
import { formatTimecode } from "@movies/ui/lib/timecode";

import { artworkUrl } from "@/lib/artwork";

import { AUTOPLAY_COUNTDOWN } from "./autoplay";

/**
 * The overlay around the shrunken video.
 *
 * @param current - `Severance · S2:E4 Woe's Hollow`, under the video.
 * @param remainingSeconds - Time left in the episode playing.
 * @param countdownMs - Time left before the next episode starts.
 */
export function AutoplayNext({
  current,
  remainingSeconds,
  next,
  countdownMs,
  onPlayNext,
  onWatchCredits,
}: {
  readonly current: string;
  readonly remainingSeconds: number;
  readonly next: Episode;
  readonly countdownMs: number;
  readonly onPlayNext: () => void;
  readonly onWatchCredits: () => void;
}) {
  const still = artworkUrl(next.still, "card");
  const seconds = Math.max(0, Math.ceil(countdownMs / 1000));

  return (
    <div className="on-media pointer-events-none absolute inset-0 font-sans">
      <div className="absolute top-49 left-16 hidden w-1/2 flex-col gap-5 md:flex">
        <div aria-hidden className="aspect-video" />
        <p className="flex items-center gap-3">
          <span className="text-body/body font-semibold text-text">{current}</span>
          <span className="font-mono text-label/body text-text-muted">
            {formatTimecode(-remainingSeconds)}
          </span>
        </p>
      </div>
      <section
        aria-label="Next episode"
        className="pointer-events-auto absolute inset-x-6 bottom-8 flex flex-col gap-6 md:inset-x-auto md:top-49 md:right-16 md:bottom-auto md:left-[calc(50%+var(--spacing-32))]"
      >
        <div
          className="relative hidden aspect-video items-end overflow-hidden rounded-card bg-dark-surface-raised bg-cover bg-center p-4 md:flex"
          style={still === undefined ? undefined : { backgroundImage: `url("${still}")` }}
        >
          {next.runtimeMs === null ? null : (
            <span className="rounded-bar bg-dark-bg/55 px-1.5 py-0.5 font-mono text-caption/caption text-text">
              {formatRuntime(next.runtimeMs)}
            </span>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <p className="text-label/label font-semibold tracking-caps text-text-muted uppercase">
            Next episode
          </p>
          <h2 className="text-heading/heading font-heavy tracking-tight text-text md:text-title/title">
            {episodeCode(next)} {next.name}
          </h2>
          {next.overview === null ? null : (
            <p className="hidden text-body/body text-text-muted md:block">{next.overview}</p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="inverse"
            size="lg"
            className="h-13 gap-3 pr-6 pl-3.5 text-button/5"
            autoFocus
            onClick={onPlayNext}
          >
            <ProgressRing
              value={1 - countdownMs / AUTOPLAY_COUNTDOWN.totalMs}
              thickness={7}
              className="size-8 text-dark-bg"
            >
              <span className="font-mono text-caption/caption font-semibold text-dark-bg">
                {seconds}
              </span>
            </ProgressRing>
            Next episode
          </Button>
          <Button
            variant="secondary"
            size="lg"
            className="h-13 text-button/5"
            onClick={onWatchCredits}
          >
            Watch credits
          </Button>
        </div>
      </section>
    </div>
  );
}
