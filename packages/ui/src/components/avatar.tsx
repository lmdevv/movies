import { cn } from "@movies/ui/lib/utils";
import { PencilIcon } from "lucide-react";

const SIZES = {
  /** 28px, the compact phone top bar. */
  xs: "size-7",
  /** 32px, the desktop top bar, large titles and room members. */
  sm: "size-8",
  /** 96px, PIN entry. */
  md: "size-24",
  /** 112px, the profile editor. */
  lg: "size-28",
  /** 160px, the profile picker. */
  xl: "size-40",
} as const;

const MONOGRAMS = {
  xs: "p-1 text-caption/4",
  sm: "p-1 text-caption/4",
  md: "p-2.5 text-4xl/9",
  lg: "p-3 text-title/title",
  xl: "p-3.5 text-display/display",
} as const;

/** Avatar dimensions, from the 28px compact bar up to the 160px profile picker. */
export type AvatarSize = keyof typeof SIZES;

/**
 * A profile picture. Without an image, or with `monogram`, it shows the name's first letter in the
 * bottom-left corner the way the profile picker draws it.
 *
 * @param image - Picture URL; omit for a plain raised tile.
 * @param round - Draw a circle, as on phones; otherwise a square with 4px corners, as on desktop.
 */
export function Avatar({
  name,
  image,
  size = "sm",
  round = false,
  monogram = false,
  className,
}: {
  readonly name: string;
  readonly image?: string | undefined;
  readonly size?: AvatarSize;
  readonly round?: boolean;
  readonly monogram?: boolean;
  readonly className?: string;
}) {
  const showMonogram = monogram || image === undefined;

  return (
    <span
      data-slot="avatar"
      role="img"
      aria-label={name}
      className={cn(
        "relative flex shrink-0 items-end overflow-hidden bg-surface-raised bg-cover bg-center select-none",
        SIZES[size],
        round ? "rounded-pill" : "rounded-poster",
        className,
      )}
      style={image === undefined ? undefined : { backgroundImage: `url("${image}")` }}
    >
      {showMonogram ? (
        <span
          aria-hidden
          className={cn(
            "font-sans font-heavy tracking-display",
            image === undefined ? "text-text-muted" : "text-dark-text/85",
            MONOGRAMS[size],
          )}
        >
          {name.slice(0, 1).toUpperCase()}
        </span>
      ) : null}
    </span>
  );
}

/** An avatar with the round pencil button that opens avatar editing, as on the profile editor. */
export function EditableAvatar({
  name,
  image,
  onEdit,
  monogram,
  size = "lg",
}: {
  readonly name: string;
  readonly image?: string | undefined;
  readonly onEdit: () => void;
  readonly monogram?: boolean;
  readonly size?: AvatarSize;
}) {
  return (
    <span className="relative inline-flex shrink-0">
      <Avatar name={name} size={size} image={image} monogram={monogram ?? false} />
      <button
        type="button"
        onClick={onEdit}
        aria-label={`Edit ${name}'s avatar`}
        className="on-media absolute right-2 bottom-2 flex size-8 cursor-pointer items-center justify-center rounded-pill bg-dark-bg/55 backdrop-blur-md transition-colors hover:bg-dark-bg/75"
      >
        <PencilIcon className="size-3.5" strokeWidth={1.75} aria-hidden />
      </button>
    </span>
  );
}
