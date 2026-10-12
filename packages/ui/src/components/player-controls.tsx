import { Slider } from "@base-ui/react/slider";
import { formatTimecode } from "@movies/ui/lib/timecode";
import { cn } from "@movies/ui/lib/utils";
import {
  CaptionsIcon,
  RotateCcwIcon,
  RotateCwIcon,
  UsersIcon,
  Volume2Icon,
  VolumeXIcon,
} from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { PauseGlyph, PlayGlyph, SkipNextGlyph } from "./icons";

/** Paper's corner-bracket fullscreen glyph. */
function FullscreenGlyph(props: ComponentProps<"svg">) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      aria-hidden
      {...props}
    >
      <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
    </svg>
  );
}

/** A bare transport button: a white glyph with a label for assistive tech. */
export function PlayerButton({
  className,
  type = "button",
  ...props
}: ComponentProps<"button"> & { readonly "aria-label": string }) {
  return (
    <button
      type={type}
      className={cn(
        "flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-xs text-text transition-opacity hover:opacity-80 disabled:opacity-(--opacity-disabled) [&_svg]:size-6.5",
        className,
      )}
      {...props}
    />
  );
}

/**
 * The playback scrubber. Arrow keys step 5 seconds and Page Up/Down a minute; the value text reads
 * the position as a timecode.
 */
export function Scrubber({
  position,
  duration,
  onSeek,
  onSeekCommit,
  className,
}: {
  readonly position: number;
  readonly duration: number;
  readonly onSeek: (seconds: number) => void;
  readonly onSeekCommit?: ((seconds: number) => void) | undefined;
  readonly className?: string;
}) {
  return (
    <Slider.Root
      value={Math.min(position, duration)}
      min={0}
      max={Math.max(duration, 1)}
      step={5}
      largeStep={60}
      onValueChange={(value) => onSeek(value)}
      onValueCommitted={(value) => onSeekCommit?.(value)}
      className={cn("flex-1", className)}
    >
      <Slider.Control className="flex h-3.5 w-full cursor-pointer touch-none items-center">
        <Slider.Track className="relative h-1 w-full rounded-xs bg-text/25">
          <Slider.Indicator className="rounded-xs bg-accent" />
          <Slider.Thumb
            aria-label="Seek"
            getAriaValueText={(_, value) =>
              `${formatTimecode(value)} of ${formatTimecode(duration)}`
            }
            className="size-3.5 rounded-pill bg-accent"
          />
        </Slider.Track>
      </Slider.Control>
    </Slider.Root>
  );
}

/**
 * The player's bottom controls over a dark gradient: scrubber and remaining time, transport on the
 * left, the title in the middle, and next episode, tracks, room and fullscreen on the right.
 *
 * @param position - Seconds played.
 * @param duration - Length in seconds.
 * @param tracks - The audio and subtitles control, usually a {@link TrackPopover} trigger.
 */
export function PlayerControls({
  title,
  playing,
  position,
  duration,
  muted = false,
  tracks,
  onPlayPause,
  onSeek,
  onSeekCommit,
  onMuteChange,
  onNext,
  onRoom,
  onFullscreen,
  className,
}: {
  readonly title: string;
  readonly playing: boolean;
  readonly position: number;
  readonly duration: number;
  readonly muted?: boolean;
  readonly tracks?: ReactNode;
  readonly onPlayPause: () => void;
  readonly onSeek: (seconds: number) => void;
  readonly onSeekCommit?: (seconds: number) => void;
  readonly onMuteChange?: (muted: boolean) => void;
  readonly onNext?: () => void;
  readonly onRoom?: () => void;
  readonly onFullscreen?: () => void;
  readonly className?: string;
}) {
  const skip = (by: number): void => onSeek(Math.min(duration, Math.max(0, position + by)));

  return (
    <div
      data-slot="player-controls"
      className={cn(
        "on-media flex w-full flex-col gap-3.5 bg-linear-to-b from-transparent to-dark-bg/85 to-60% px-7 py-6",
        className,
      )}
    >
      <div className="flex items-center gap-3.5">
        <Scrubber
          position={position}
          duration={duration}
          onSeek={onSeek}
          onSeekCommit={onSeekCommit}
        />
        <span className="font-mono text-label/4 tabular-nums">
          {formatTimecode(position - duration)}
        </span>
      </div>
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-6">
        <div className="flex items-center gap-6.5">
          <PlayerButton
            aria-label={playing ? "Pause" : "Play"}
            onClick={onPlayPause}
            className="[&_svg]:size-7"
          >
            {playing ? <PauseGlyph /> : <PlayGlyph />}
          </PlayerButton>
          <PlayerButton aria-label="Back 10 seconds" onClick={() => skip(-10)}>
            <RotateCcwIcon strokeWidth={1.75} aria-hidden />
          </PlayerButton>
          <PlayerButton aria-label="Forward 10 seconds" onClick={() => skip(10)}>
            <RotateCwIcon strokeWidth={1.75} aria-hidden />
          </PlayerButton>
          {onMuteChange === undefined ? null : (
            <PlayerButton
              aria-label={muted ? "Unmute" : "Mute"}
              aria-pressed={muted}
              onClick={() => onMuteChange(!muted)}
            >
              {muted ? (
                <VolumeXIcon strokeWidth={1.75} aria-hidden />
              ) : (
                <Volume2Icon strokeWidth={1.75} aria-hidden />
              )}
            </PlayerButton>
          )}
        </div>
        <p className="truncate text-center font-sans text-body/4.5 font-semibold">{title}</p>
        <div className="flex items-center justify-end gap-6">
          {onNext === undefined ? null : (
            <PlayerButton aria-label="Next episode" onClick={onNext}>
              <SkipNextGlyph />
            </PlayerButton>
          )}
          {tracks}
          {onRoom === undefined ? null : (
            <PlayerButton aria-label="Watch together" onClick={onRoom}>
              <UsersIcon strokeWidth={1.75} aria-hidden />
            </PlayerButton>
          )}
          {onFullscreen === undefined ? null : (
            <PlayerButton aria-label="Full screen" onClick={onFullscreen}>
              <FullscreenGlyph />
            </PlayerButton>
          )}
        </div>
      </div>
    </div>
  );
}

/** The captions glyph used by the audio and subtitles button. */
export function TracksGlyph() {
  return <CaptionsIcon strokeWidth={1.75} aria-hidden />;
}
