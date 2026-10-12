import { Slider } from "@base-ui/react/slider";
import { formatTimecode } from "@movies/ui/lib/timecode";
import { cn } from "@movies/ui/lib/utils";
import {
  CaptionsIcon,
  LockIcon,
  RotateCcwIcon,
  RotateCwIcon,
  UsersIcon,
  Volume2Icon,
  VolumeXIcon,
} from "lucide-react";
import { useState } from "react";
import type { ComponentProps, PointerEvent, ReactNode } from "react";

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

/**
 * A bare transport button: a white glyph with a label for assistive tech. `active` draws the
 * translucent square Paper puts behind an open panel's button.
 */
export function PlayerButton({
  className,
  type = "button",
  active = false,
  ...props
}: ComponentProps<"button"> & { readonly "aria-label": string; readonly active?: boolean }) {
  return (
    <button
      type={type}
      data-active={active || undefined}
      className={cn(
        "relative flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-xs text-text transition-opacity before:absolute before:-inset-2 before:rounded-control before:bg-text/14 before:opacity-0 hover:opacity-80 disabled:opacity-(--opacity-disabled) data-active:before:opacity-100 data-popup-open:before:opacity-100 [&_svg]:relative [&_svg]:size-6.5",
        className,
      )}
      {...props}
    />
  );
}

/**
 * The playback scrubber. Arrow keys step 5 seconds and Page Up/Down a minute; the value text reads
 * the position as a timecode. Hovering shows the time under the pointer.
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
  const [hover, setHover] = useState<number | null>(null);

  const track = (event: PointerEvent<HTMLDivElement>): void => {
    const box = event.currentTarget.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));

    setHover(fraction);
  };

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
      <Slider.Control
        onPointerMove={track}
        onPointerLeave={() => setHover(null)}
        className="relative flex h-3.5 w-full cursor-pointer touch-none items-center"
      >
        {hover === null ? null : (
          <span
            aria-hidden
            data-slot="scrubber-hover"
            className="pointer-events-none absolute bottom-full mb-2 flex -translate-x-1/2 flex-col items-center gap-3"
            style={{ left: `${String(hover * 100)}%` }}
          >
            <span className="font-mono text-label/caption text-text">
              {formatTimecode(hover * duration)}
            </span>
            <span className="h-3 w-0.5 rounded-xs bg-text" />
          </span>
        )}
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

/** A progress bar that cannot be moved, for viewers who follow someone else's timeline. */
function ProgressLine({
  position,
  duration,
}: {
  readonly position: number;
  readonly duration: number;
}) {
  const fraction = duration <= 0 ? 0 : Math.min(1, Math.max(0, position / duration));

  return (
    <div
      role="progressbar"
      aria-label="Position"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(position)}
      aria-valuetext={`${formatTimecode(position)} of ${formatTimecode(duration)}`}
      className="flex h-1 flex-1 rounded-xs bg-text/25"
    >
      <div className="h-1 rounded-xs bg-accent" style={{ width: `${String(fraction * 100)}%` }} />
    </div>
  );
}

/**
 * The player's bottom controls over a dark gradient: scrubber and remaining time, transport on the
 * left, the title in the middle, and next episode, tracks, room and fullscreen on the right.
 *
 * @param position - Seconds played.
 * @param onSeek - Follows the scrubber while it moves; `onSeekCommit` gets where it was let go,
 *   and the skip buttons' targets.
 * @param duration - Length in seconds.
 * @param tracks - The audio and subtitles control, usually a {@link TrackPopover} trigger.
 * @param locked - Replaces the transport and the scrubber with a lock line, such as `Only Alex
 *   can pause or seek`, for a room guest.
 * @param roomActive - The room panel is open, so its button shows as active.
 */
export function PlayerControls({
  title,
  playing,
  position,
  duration,
  muted = false,
  tracks,
  locked,
  roomActive = false,
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
  readonly locked?: string | undefined;
  readonly roomActive?: boolean;
  readonly onPlayPause: () => void;
  readonly onSeek: (seconds: number) => void;
  readonly onSeekCommit?: ((seconds: number) => void) | undefined;
  readonly onMuteChange?: ((muted: boolean) => void) | undefined;
  readonly onNext?: (() => void) | undefined;
  readonly onRoom?: (() => void) | undefined;
  readonly onFullscreen?: (() => void) | undefined;
  readonly className?: string;
}) {
  const skip = (by: number): void =>
    (onSeekCommit ?? onSeek)(Math.min(duration, Math.max(0, position + by)));

  return (
    <div
      data-slot="player-controls"
      className={cn(
        "on-media flex w-full flex-col gap-5 bg-linear-to-b from-transparent to-dark-bg/85 to-60% px-10 pt-30 pb-9",
        className,
      )}
    >
      <div className="flex items-center gap-3.5">
        {locked === undefined ? (
          <Scrubber
            position={position}
            duration={duration}
            onSeek={onSeek}
            onSeekCommit={onSeekCommit}
          />
        ) : (
          <ProgressLine position={position} duration={duration} />
        )}
        <span className="font-mono text-label/caption text-text tabular-nums">
          {formatTimecode(position - duration)}
        </span>
      </div>
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-6">
        <div className="flex items-center gap-6.5">
          {locked === undefined ? (
            <>
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
            </>
          ) : (
            <span className="flex h-9 items-center gap-2.5 rounded-pill bg-text/10 pr-3.5 pl-3 font-sans text-label/caption font-medium text-text">
              <LockIcon className="size-4" strokeWidth={1.75} aria-hidden />
              {locked}
            </span>
          )}
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
        <p className="truncate text-center font-sans text-lead/body font-semibold">{title}</p>
        <div className="flex items-center justify-end gap-6">
          {onNext === undefined ? null : (
            <PlayerButton aria-label="Next episode" onClick={onNext}>
              <SkipNextGlyph />
            </PlayerButton>
          )}
          {tracks}
          {onRoom === undefined ? null : (
            <PlayerButton
              aria-label="Watch together"
              aria-pressed={roomActive}
              active={roomActive}
              onClick={onRoom}
            >
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
