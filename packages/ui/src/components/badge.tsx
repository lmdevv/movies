import { cn } from "@movies/ui/lib/utils";
import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

const badgeVariants = cva(
  "inline-flex h-5 shrink-0 items-center rounded-poster px-1.5 text-micro/3.5",
  {
    variants: {
      variant: {
        /** Mono outline for technical facts: `4K HDR`, `ATMOS`. Takes the surrounding text color. */
        outline: "border border-current/40 font-mono",
        /** Red label on artwork: `NEW`, `NEW EPISODE`. */
        accent: "bg-accent font-sans font-bold tracking-caps text-on-accent uppercase",
      },
    },
    defaultVariants: { variant: "outline" },
  },
);

/** A small label: technical facts in mono outline, or a red `NEW` flag on artwork. */
export function Badge({
  className,
  variant,
  ...props
}: ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return (
    <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}
