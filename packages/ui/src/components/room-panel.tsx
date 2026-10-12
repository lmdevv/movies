import { cn } from "@movies/ui/lib/utils";
import { LinkIcon } from "lucide-react";

import { Avatar } from "./avatar";
import { Button } from "./button";

/** How a room member's playback compares with the host's. */
export type RoomMemberSync =
  | { readonly kind: "in-sync" }
  /** Behind or catching up; `label` is the drift, such as `-2.4s`. */
  | { readonly kind: "drifting"; readonly label: string };

/** Someone in a watch room. */
export type RoomMember = {
  readonly id: string;
  readonly name: string;
  /** Where and how they watch, such as `Host · this device` or `Lisbon · transcode 1080p`. */
  readonly detail: string;
  readonly avatar?: string | undefined;
  readonly sync: RoomMemberSync;
};

/**
 * The watch-together panel beside the player: who is watching and whether each person is in sync,
 * with the invite link and, for the host, End room.
 *
 * @param onEnd - Ends the room for everyone; omit for guests.
 */
export function RoomPanel({
  members,
  onCopyLink,
  onEnd,
  className,
}: {
  readonly members: ReadonlyArray<RoomMember>;
  readonly onCopyLink: () => void;
  readonly onEnd?: (() => void) | undefined;
  readonly className?: string;
}) {
  return (
    <section
      aria-label="Watching together"
      data-slot="room-panel"
      className={cn(
        "flex w-85 flex-col gap-5 rounded-control bg-surface-raised p-5 font-sans",
        className,
      )}
    >
      <header className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-body/4.5 font-bold text-text">
          <span aria-hidden className="size-2 shrink-0 rounded-pill bg-accent" />
          Watching together
        </h2>
        <button
          type="button"
          onClick={onCopyLink}
          aria-label="Copy room link"
          className="flex size-6 cursor-pointer items-center justify-center rounded-xs text-text-muted transition-colors hover:text-text"
        >
          <LinkIcon className="size-4.5" strokeWidth={1.75} aria-hidden />
        </button>
      </header>
      <ul className="flex flex-col gap-3">
        {members.map((member) => (
          <li key={member.id} className="flex items-center gap-3">
            <Avatar name={member.name} image={member.avatar} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-label/4 font-semibold text-text">{member.name}</span>
              <span className="truncate text-caption/4 text-text-muted">{member.detail}</span>
            </span>
            <span
              className={cn(
                "w-16 shrink-0 text-right font-mono text-caption/4",
                member.sync.kind === "in-sync" ? "text-success" : "text-warning",
              )}
            >
              {member.sync.kind === "in-sync" ? "in sync" : member.sync.label}
            </span>
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Button variant="subtle" size="sm" className="flex-1" onClick={onCopyLink}>
          Copy invite link
        </Button>
        {onEnd === undefined ? null : (
          <Button variant="ghost" size="sm" onClick={onEnd}>
            End room
          </Button>
        )}
      </div>
    </section>
  );
}
