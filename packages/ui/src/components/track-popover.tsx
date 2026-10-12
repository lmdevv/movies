import { Popover } from "@base-ui/react/popover";
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { cn } from "@movies/ui/lib/utils";
import { CheckIcon } from "lucide-react";
import { useId } from "react";
import type { ReactElement } from "react";

/** One choice in the audio or subtitles column. */
export type TrackOption = { readonly id: string; readonly label: string };

function TrackColumn({
  label,
  options,
  value,
  onValueChange,
}: {
  readonly label: string;
  readonly options: ReadonlyArray<TrackOption>;
  readonly value: string;
  readonly onValueChange: (id: string) => void;
}) {
  const labelId = useId();

  return (
    <div className="flex flex-1 flex-col gap-0.5 p-5">
      <span
        id={labelId}
        className="pb-2.5 font-sans text-caption/caption font-medium tracking-caps text-text-muted uppercase"
      >
        {label}
      </span>
      <RadioGroup
        aria-labelledby={labelId}
        value={value}
        onValueChange={(next) => onValueChange(next)}
        className="flex flex-col gap-0.5"
      >
        {options.map((option) => (
          <Radio.Root
            key={option.id}
            value={option.id}
            className="group/track flex h-10 cursor-pointer items-center gap-2.5 rounded-xs text-left font-sans text-body/label text-text-muted transition-colors hover:text-text data-checked:font-semibold data-checked:text-text"
          >
            <span className="flex size-4 shrink-0 items-center justify-center">
              <Radio.Indicator>
                <CheckIcon className="size-4 text-accent" strokeWidth={2.5} aria-hidden />
              </Radio.Indicator>
            </span>
            {option.label}
          </Radio.Root>
        ))}
      </RadioGroup>
    </div>
  );
}

/** The current audio and subtitle choices and how to change them. */
export type TrackSelection = {
  readonly audio: ReadonlyArray<TrackOption>;
  readonly subtitles: ReadonlyArray<TrackOption>;
  readonly audioId: string;
  readonly subtitleId: string;
  readonly onAudioChange: (id: string) => void;
  readonly onSubtitleChange: (id: string) => void;
};

/**
 * The two-column audio and subtitles chooser. Each column is a radio group: arrow keys move the
 * choice, Tab moves between columns.
 */
export function TrackPanel({
  className,
  ...selection
}: TrackSelection & { readonly className?: string }) {
  return (
    <div
      data-slot="track-panel"
      className={cn(
        "flex w-115 overflow-hidden rounded-control border border-hairline bg-surface-raised",
        className,
      )}
    >
      <TrackColumn
        label="Audio"
        options={selection.audio}
        value={selection.audioId}
        onValueChange={selection.onAudioChange}
      />
      <div aria-hidden className="w-px shrink-0 bg-hairline" />
      <TrackColumn
        label="Subtitles"
        options={selection.subtitles}
        value={selection.subtitleId}
        onValueChange={selection.onSubtitleChange}
      />
    </div>
  );
}

/**
 * The {@link TrackPanel} in a popover above the player's tracks button. Focus moves into the panel
 * when it opens and returns to the button when it closes; Escape closes it.
 *
 * @param trigger - The button that opens it, such as a `PlayerButton` with the captions glyph.
 * @param container - Where it renders; pass the full-screen element so it stays visible there.
 */
export function TrackPopover({
  trigger,
  container,
  ...selection
}: TrackSelection & {
  readonly trigger: ReactElement;
  /** Where the popover renders, such as the player while it is full screen; the body otherwise. */
  readonly container?: HTMLElement | null | undefined;
}) {
  return (
    <Popover.Root>
      <Popover.Trigger render={trigger} />
      <Popover.Portal container={container}>
        <Popover.Positioner
          side="top"
          align="end"
          sideOffset={76}
          alignOffset={-32}
          collisionPadding={16}
          className="z-50"
        >
          <Popover.Popup
            aria-label="Audio and subtitles"
            className="origin-(--transform-origin) shadow-overlay transition-[opacity,scale] data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0"
          >
            <TrackPanel {...selection} />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
