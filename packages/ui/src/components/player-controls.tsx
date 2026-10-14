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
import { useEffect, useRef, useState } from "react";
import type { ComponentProps, PointerEvent, ReactNode } from "react";

import { PauseGlyph, PlayGlyph, SkipNextGlyph } from "./icons";
import { SpriteThumbnail } from "./sprite-thumbnail";
import type { SpriteTile } from "./sprite-thumbnail";

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
        "relative flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-bar text-text transition-opacity before:absolute before:-inset-2 before:rounded-control before:bg-text/14 before:opacity-0 hover:opacity-80 disabled:opacity-(--opacity-disabled) data-active:before:opacity-100 data-popup-open:before:opacity-100 [&_svg]:relative [&_svg]:size-6.5",
        className,
      )}
      {...props}
    />
  );
}

/** How long a keyboard seek on the scrubber shows its preview. */
const KEY_PREVIEW_MS = 1_200;

/** Keys the slider seeks with. */
const SEEK_KEYS: ReadonlySet<string> = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
]);

/** What the scrubber shows above a time: its thumbnail and chapter, when known. */
export interface ScrubPreview {
  readonly thumbnail: SpriteTile | null;
  readonly chapter: string | null;
}

const NO_PREVIEW: ScrubPreview = { thumbnail: null, chapter: null };

/**
 * The playback scrubber. Arrow keys step 5 seconds and Page Up/Down a minute; the value text reads
 * the position as a timecode. Hovering or dragging shows the time under the pointer with its
 * thumbnail and chapter (`describe`); `chapters` draws a tick at each chapter's start.
 *
 * @param preview - Shows the preview at this time without a pointer, as after a keyboard seek.
 * @param onPreviewStart - Called once the viewer first points at or focuses the scrubber, so
 *   thumbnails can load before they are needed.
 */
export function Scrubber({
  position,
  duration,
  onSeek,
  onSeekCommit,
  describe,
  chapters,
  preview,
  onPreviewStart,
  className,
}: {
  readonly position: number;
  readonly duration: number;
  readonly onSeek: (seconds: number) => void;
  readonly onSeekCommit?: ((seconds: number) => void) | undefined;
  readonly describe?: ((seconds: number) => ScrubPreview) | undefined;
  /** Chapter starts in seconds. */
  readonly chapters?: ReadonlyArray<number> | undefined;
  readonly preview?: number | null | undefined;
  readonly onPreviewStart?: (() => void) | undefined;
  readonly className?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  // Arrow and Page keys on the focused thumb seek too; their preview shows for a moment.
  const [keyed, setKeyed] = useState(false);
  const keyedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const length = Math.max(duration, 1);

  useEffect(() => () => clearTimeout(keyedTimer.current), []);

  const showKeyed = (): void => {
    setKeyed(true);
    clearTimeout(keyedTimer.current);
    keyedTimer.current = setTimeout(() => setKeyed(false), KEY_PREVIEW_MS);
  };

  // A drag ends wherever the pointer is released, even off the bar or without moving the value.
  useEffect(() => {
    if (!dragging) return undefined;

    const end = (): void => setDragging(false);

    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);

    return () => {
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, [dragging]);

  const track = (event: PointerEvent<HTMLDivElement>): void => {
    const box = event.currentTarget.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));

    setHover(fraction * duration);
  };

  // Dragging or keying previews where the thumb is; otherwise the pointer, then a forced preview.
  const shown = dragging || keyed ? Math.min(position, duration) : (hover ?? preview ?? null);
  const details = shown === null ? NO_PREVIEW : (describe?.(shown) ?? NO_PREVIEW);

  return (
    <Slider.Root
      value={Math.min(position, duration)}
      min={0}
      max={length}
      step={5}
      largeStep={60}
      onValueChange={(value) => onSeek(value)}
      onValueCommitted={(value) => {
        setDragging(false);
        onSeekCommit?.(value);
      }}
      className={cn("flex-1", className)}
    >
      <Slider.Control
        data-slot="scrubber"
        onPointerEnter={onPreviewStart}
        onPointerDown={(event) => {
          if (event.button === 0) setDragging(true);
        }}
        onPointerMove={track}
        onPointerLeave={() => setHover(null)}
        onFocus={onPreviewStart}
        className="relative flex h-3.5 w-full cursor-pointer touch-none items-center"
      >
        {shown === null ? null : (
          <span
            aria-hidden
            data-slot="scrubber-hover"
            className="pointer-events-none absolute bottom-full mb-2 flex -translate-x-1/2 flex-col items-center gap-1.5"
            style={{ left: `${String((shown / length) * 100)}%` }}
          >
            {details.thumbnail === null ? null : (
              <SpriteThumbnail
                tile={details.thumbnail}
                className="w-48 shadow-overlay ring-1 ring-text/25"
              />
            )}
            {details.chapter === null ? null : (
              <span
                data-slot="scrubber-chapter"
                className="max-w-48 truncate font-sans text-label/caption font-semibold text-text"
              >
                {details.chapter}
              </span>
            )}
            <span data-slot="scrubber-time" className="font-mono text-label/caption text-text">
              {formatTimecode(shown)}
            </span>
            <span className="h-3 w-0.5 rounded-bar bg-text" />
          </span>
        )}
        <Slider.Track className="relative h-1 w-full rounded-bar bg-text/25">
          <Slider.Indicator className="rounded-bar bg-accent" />
          {(chapters ?? [])
            .filter((start) => start > 0 && start < duration)
            .map((start) => (
              <span
                key={start}
                aria-hidden
                data-slot="scrubber-chapter-mark"
                className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-dark-bg/70"
                style={{ left: `${String((start / length) * 100)}%` }}
              />
            ))}
          <Slider.Thumb
            aria-label="Seek"
            onKeyDown={(event) => {
              if (SEEK_KEYS.has(event.key)) showKeyed();
            }}
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
      className="flex h-1 flex-1 rounded-bar bg-text/25"
    >
      <div className="h-1 rounded-bar bg-accent" style={{ width: `${String(fraction * 100)}%` }} />
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
 * @param chapterList - The chapters control, usually a `ChapterPopover` trigger.
 * @param scrub - Thumbnails, chapter marks, and a forced preview for the scrubber
 *   ({@link Scrubber}).
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
  chapterList,
  scrub,
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
  readonly chapterList?: ReactNode;
  readonly scrub?: Pick<
    ComponentProps<typeof Scrubber>,
    "describe" | "chapters" | "preview" | "onPreviewStart"
  >;
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
            {...scrub}
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
          {chapterList}
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
