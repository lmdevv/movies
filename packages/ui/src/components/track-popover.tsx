import { Popover } from "@base-ui/react/popover";
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { cn } from "@movies/ui/lib/utils";
import { CheckIcon } from "lucide-react";
import { Fragment, useId } from "react";
import type { ReactElement } from "react";

/** One choice in a column, such as an audio track or a version of the film. */
export type TrackOption = {
  readonly id: string;
  readonly label: string;
  /** A muted line under the label, such as a version's `4K · HDR10 · HEVC`. */
  readonly detail?: string | undefined;
};

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
            className={cn(
              "group/track flex cursor-pointer items-center gap-2.5 rounded-bar text-left font-sans text-body/label text-text-muted transition-colors hover:text-text data-checked:font-semibold data-checked:text-text",
              option.detail === undefined ? "h-10" : "min-h-10 py-1.5",
            )}
          >
            <span
              className={cn(
                "flex size-4 shrink-0 items-center justify-center",
                option.detail !== undefined && "self-start pt-0.5",
              )}
            >
              <Radio.Indicator>
                <CheckIcon className="size-4 text-accent" strokeWidth={2.5} aria-hidden />
              </Radio.Indicator>
            </span>
            {option.detail === undefined ? (
              option.label
            ) : (
              <span className="flex min-w-0 flex-col gap-0.5">
                {option.label}
                <span className="text-caption/caption font-regular text-text-muted">
                  {option.detail}
                </span>
              </span>
            )}
          </Radio.Root>
        ))}
      </RadioGroup>
    </div>
  );
}

/** One column of choices, such as the audio tracks, the subtitles, or the stream quality. */
export type TrackChoice = {
  /** Stable key, such as `audio`. */
  readonly id: string;
  readonly label: string;
  readonly options: ReadonlyArray<TrackOption>;
  readonly value: string;
  readonly onValueChange: (id: string) => void;
};

/** The columns of choices, left to right. */
export type TrackSelection = {
  readonly choices: ReadonlyArray<TrackChoice>;
};

/** Panel widths by column count: two columns as designed, each further column as wide again. */
const PANEL_WIDTHS = ["w-60", "w-60", "w-115", "w-170", "w-225"] as const;

/**
 * The player's chooser: one column per choice (the version when a title has several, audio,
 * subtitles, and quality in the player).
 * Each column is a radio group: arrow keys move the choice, Tab moves between columns.
 */
export function TrackPanel({
  className,
  choices,
}: TrackSelection & { readonly className?: string }) {
  return (
    <div
      data-slot="track-panel"
      className={cn(
        "flex overflow-hidden rounded-control border border-hairline bg-surface-raised",
        PANEL_WIDTHS[Math.min(choices.length, PANEL_WIDTHS.length - 1)],
        className,
      )}
    >
      {choices.map((choice, index) => (
        <Fragment key={choice.id}>
          {index > 0 ? <div aria-hidden className="w-px shrink-0 bg-hairline" /> : null}
          <TrackColumn
            label={choice.label}
            options={choice.options}
            value={choice.value}
            onValueChange={choice.onValueChange}
          />
        </Fragment>
      ))}
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
  label,
  choices,
}: TrackSelection & {
  /** The popover's accessible name, matching its trigger's, such as `Audio and subtitles`. */
  readonly label: string;
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
            aria-label={label}
            className="origin-(--transform-origin) shadow-overlay transition-[opacity,scale] data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0"
          >
            {/* On a phone the panel can be wider than the screen: cap it there, and its columns scroll. */}
            <TrackPanel choices={choices} className="max-w-(--available-width) overflow-x-auto" />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
