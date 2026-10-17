/**
 * The next-episode card: near the end of an episode, the credits keep playing in the full frame
 * while a compact card in the corner names the next episode and counts down to it. Play next plays
 * it now; Watch credits cancels the countdown and closes the card. Paper 07 · 05 still draws the
 * earlier layout (the video shrunk beside a large still); this one awaits its Paper check.
 */
import type { Episode } from "@movies/contracts/models/catalog";
import { Button } from "@movies/ui/components/button";
import { cn } from "@movies/ui/lib/utils";
import { PlayIcon, TvIcon } from "lucide-react";

import { episodeCode, facts, formatRuntime } from "@/lib/format";

import { AUTOPLAY_COUNTDOWN } from "./autoplay";

/**
 * What this viewer can do about the countdown. `advance`: playing on their own, or a room's host,
 * they play the next episode now or watch the credits instead. `follow`: a room's guest sees the
 * host's countdown and can only close the card on this screen.
 */
export type NextEpisodeActions =
  | {
      readonly kind: "advance";
      readonly onPlayNext: () => void;
      readonly onWatchCredits: () => void;
    }
  | { readonly kind: "follow"; readonly onClose: () => void };

/** The parts of the next episode the card shows. */
export type NextEpisode = Pick<
  Episode,
  "seasonNumber" | "episodeNumber" | "name" | "overview" | "runtimeMs"
>;

/**
 * The card over the playing credits, in the bottom corner (across the bottom on phones held
 * upright).
 *
 * @param still - The next episode's still, sized for a card; without one the tile shows a glyph.
 * @param countdownMs - Time left before the next episode starts.
 */
export function AutoplayNext({
  next,
  still,
  countdownMs,
  actions,
}: {
  readonly next: NextEpisode;
  readonly still: string | undefined;
  readonly countdownMs: number;
  readonly actions: NextEpisodeActions;
}) {
  const seconds = Math.max(0, Math.ceil(countdownMs / 1000));
  const elapsed = 1 - countdownMs / AUTOPLAY_COUNTDOWN.totalMs;

  return (
    <div className="on-media pointer-events-none absolute inset-0 flex items-end justify-end p-4 font-sans md:p-12 short:p-4">
      <section
        aria-label="Next episode"
        data-slot="next-episode"
        className="pointer-events-auto mr-[env(safe-area-inset-right)] mb-[env(safe-area-inset-bottom)] flex w-full max-w-full flex-col gap-4 rounded-card bg-dark-surface-raised p-4 shadow-overlay md:w-(--spacing-next-card) md:p-5 short:w-(--spacing-next-card)"
      >
        <p className="text-caption/caption font-semibold tracking-caps text-text-muted uppercase">
          Next episode
        </p>
        <div className="flex items-start gap-4">
          <div
            data-slot="next-episode-still"
            className="flex aspect-video w-28 max-w-1/3 shrink-0 short:w-20 items-center justify-center overflow-hidden rounded-poster bg-text/5 bg-cover bg-center text-text-muted"
            style={still === undefined ? undefined : { backgroundImage: `url("${still}")` }}
          >
            {still === undefined ? <TvIcon aria-hidden className="size-6" /> : null}
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-label/label text-text-muted tabular-nums">
              {facts(
                episodeCode(next),
                next.runtimeMs === null ? null : formatRuntime(next.runtimeMs),
              )}
            </p>
            <h2 className="line-clamp-2 short:line-clamp-1 text-heading/heading font-bold tracking-tight wrap-break-word text-text">
              {next.name}
            </h2>
          </div>
        </div>
        {next.overview === null ? null : (
          <p className="line-clamp-2 text-label/label text-text-muted short:hidden">
            {next.overview}
          </p>
        )}
        {actions.kind === "advance" ? (
          <div className="flex flex-wrap gap-3">
            <Button
              variant="inverse"
              size="md"
              className="relative isolate grow overflow-hidden bg-text/70 hover:bg-text/80"
              autoFocus
              onClick={actions.onPlayNext}
            >
              <CountdownFill elapsed={elapsed} className="bg-text" />
              <PlayIcon aria-hidden className="fill-current" />
              <span>Play next</span>
              <Seconds value={seconds} />
            </Button>
            <Button variant="secondary" size="md" className="grow" onClick={actions.onWatchCredits}>
              Watch credits
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap gap-3">
            <p
              role="timer"
              aria-label={`Starts in ${String(seconds)} ${seconds === 1 ? "second" : "seconds"}`}
              className="relative isolate flex h-11 grow items-center justify-center gap-2 overflow-hidden rounded-control bg-text/10 px-5 text-body/4.5 font-semibold text-text"
            >
              <CountdownFill elapsed={elapsed} className="bg-text/15" />
              Starts in
              <Seconds value={seconds} />
            </p>
            <Button variant="secondary" size="md" className="grow" onClick={actions.onClose}>
              Close
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}

/**
 * The countdown's progress across its control, from the left. It moves a second at a time and
 * glides between steps, unless the viewer asked for less motion.
 */
function CountdownFill({
  elapsed,
  className,
}: {
  readonly elapsed: number;
  readonly className: string;
}) {
  return (
    <span
      aria-hidden
      data-slot="countdown-fill"
      className={cn(
        "absolute inset-0 -z-10 origin-left transition-transform duration-1000 ease-linear",
        className,
      )}
      style={{ transform: `scaleX(${String(Math.min(1, Math.max(0, elapsed)))})` }}
    />
  );
}

/**
 * The seconds left, in a box two digits wide with digits of one width, so nothing beside it moves
 * as they count down. Hidden from screen readers, which would read every tick.
 */
function Seconds({ value }: { readonly value: number }) {
  return (
    <span
      aria-hidden
      data-slot="countdown-seconds"
      className="w-7 shrink-0 text-center tabular-nums"
    >
      {value}
    </span>
  );
}
