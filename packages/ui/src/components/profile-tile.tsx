import { cn } from "@movies/ui/lib/utils";
import { LockIcon, PlusIcon } from "lucide-react";
import type { ComponentProps } from "react";

import { Avatar } from "./avatar";

const tileClassName =
  "group/tile flex w-40 shrink-0 cursor-pointer flex-col items-center gap-3.5 rounded-poster font-sans outline-none";

/** The focus and hover ring drawn around a tile's square: a 3px gap, then 3px of red. */
const ringClassName =
  "transition-shadow group-hover/tile:ring-3 group-hover/tile:ring-accent group-hover/tile:ring-offset-3 group-hover/tile:ring-offset-page group-focus-visible/tile:ring-3 group-focus-visible/tile:ring-accent group-focus-visible/tile:ring-offset-3 group-focus-visible/tile:ring-offset-page";

const nameClassName =
  "text-heading/heading font-medium text-text-muted transition-colors group-hover/tile:font-semibold group-hover/tile:text-text group-focus-visible/tile:font-semibold group-focus-visible/tile:text-text";

/**
 * A profile on the "Who's watching?" picker: a 160px square avatar and the name, with a lock under
 * profiles that need a PIN. Hover and keyboard focus draw the red ring.
 *
 * @param monogram - Draw the name's first letter over the avatar image.
 */
export function ProfileTile({
  name,
  image,
  locked = false,
  monogram = false,
  className,
  type = "button",
  ...props
}: ComponentProps<"button"> & {
  readonly name: string;
  readonly image?: string | undefined;
  readonly locked?: boolean;
  readonly monogram?: boolean;
}) {
  return (
    <button
      type={type}
      data-slot="profile-tile"
      className={cn(tileClassName, className)}
      {...props}
    >
      <Avatar name={name} image={image} size="xl" monogram={monogram} className={ringClassName} />
      <span className={nameClassName}>{name}</span>
      <span className="flex h-4 items-center justify-center text-text-muted">
        {locked ? (
          <>
            <LockIcon className="size-4" strokeWidth={1.75} aria-hidden />
            <span className="sr-only">PIN required</span>
          </>
        ) : null}
      </span>
    </button>
  );
}

/** The dashed "Add profile" tile at the end of the picker. */
export function AddProfileTile({ className, type = "button", ...props }: ComponentProps<"button">) {
  return (
    <button
      type={type}
      data-slot="add-profile-tile"
      className={cn(tileClassName, className)}
      {...props}
    >
      <span
        className={cn(
          "flex size-40 items-center justify-center rounded-poster border-[1.5px] border-dashed border-hairline text-text-muted",
          ringClassName,
        )}
      >
        <PlusIcon className="size-11" strokeWidth={1.5} aria-hidden />
      </span>
      <span className={nameClassName}>Add profile</span>
      <span className="h-4" />
    </button>
  );
}
