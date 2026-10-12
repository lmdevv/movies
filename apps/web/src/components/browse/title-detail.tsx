/**
 * A movie's or show's page (05 Browse · 04, 05, 05b, and 09 iOS): the backdrop band with the title,
 * facts and technical badges, play and resume, My List, the overview, genres and tracks, the file
 * missing warning, and a show's episodes.
 */
import type { ProfileId } from "@movies/contracts/ids";
import type { MediaFile, TitleDetail } from "@movies/contracts/models/catalog";
import { useCommand } from "@movies/sdk/react";
import { Badge } from "@movies/ui/components/badge";
import { Button, buttonVariants } from "@movies/ui/components/button";
import { PlayGlyph } from "@movies/ui/components/icons";
import { formatTimecode } from "@movies/ui/lib/timecode";
import { cn } from "@movies/ui/lib/utils";
import { Link, useRouter } from "@tanstack/react-router";
import {
  CheckIcon,
  ChevronLeftIcon,
  HardDriveIcon,
  PlusIcon,
  RotateCcwIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";
import { toast } from "sonner";

import { artworkUrl } from "@/lib/artwork";
import { toastFailure } from "@/lib/failure";
import { facts, formatRemaining, formatRuntime, plural } from "@/lib/format";
import { fileBadges, trackSummary } from "@/lib/media-facts";

import { Episodes } from "./episodes";
import { playTarget, useMyListToggle, watchSearch } from "./play-target";

/** Names longer than this draw at display size instead of the billboard size. */
const LONG_NAME = 12;

const sizeLabel = (bytes: number): string =>
  bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;

/** The playable file the page describes: the first present one. */
const mainFile = (title: TitleDetail): MediaFile | undefined =>
  title.files.find((file) => !file.missing) ?? title.files[0];

/** The page for `title`, on `profileId`. */
export function TitleDetailView({
  title,
  profileId,
  canManage,
  phone,
}: {
  readonly title: TitleDetail;
  readonly profileId: ProfileId;
  readonly canManage: boolean;
  readonly phone: boolean;
}) {
  const target = playTarget(title);
  const myList = useMyListToggle(profileId, title.id, title.inMyList, title.name);
  const file = mainFile(title);
  const badges = file === undefined ? [] : fileBadges(file);
  const tracks = file === undefined ? null : trackSummary(file);
  const backdrop = artworkUrl(title.artwork.backdrop, "backdrop");
  const logo = artworkUrl(title.artwork.logo, "card");
  const missing = !title.available;

  const remaining =
    target.fraction === null || target.positionMs === null
      ? null
      : (() => {
          const duration =
            title.kind === "movie"
              ? title.progress?.durationMs
              : title.nextEpisode?.progress?.durationMs;

          return duration === undefined ? null : duration - target.positionMs;
        })();

  const factLine = (
    <div className="flex flex-wrap items-center gap-2.5 text-body/body text-text">
      {title.year === null ? null : <span>{title.year}</span>}
      {title.certification === null ? null : (
        <Badge className="border-text/40 font-sans font-semibold">{title.certification}</Badge>
      )}
      <span>
        {title.kind === "show"
          ? plural(title.seasons.length, "season", "seasons")
          : title.runtimeMs === null
            ? null
            : formatRuntime(title.runtimeMs)}
      </span>
      {badges.map((badge) => (
        <Badge key={badge} className="border-text/40">
          {badge}
        </Badge>
      ))}
    </div>
  );

  const watch = (start: boolean) => (
    <Link
      to="/watch/$titleId"
      params={{ titleId: title.id }}
      search={watchSearch(target.episodeId, start)}
      aria-disabled={missing || undefined}
      tabIndex={missing ? -1 : undefined}
      onClick={(event) => {
        if (missing) event.preventDefault();
      }}
      className={cn(
        start
          ? buttonVariants({ variant: "secondary", size: "lg" })
          : buttonVariants({ size: phone ? "pill" : "lg" }),
        phone && !start && "h-12.5 w-full",
        missing && "pointer-events-none opacity-(--opacity-disabled)",
      )}
    >
      {start ? <RotateCcwIcon strokeWidth={1.75} aria-hidden /> : <PlayGlyph />}
      {start ? "Play from start" : target.label}
      {!start && target.resuming && target.positionMs !== null && !phone ? (
        <span className="font-mono text-caption/caption opacity-85">
          {formatTimecode(target.positionMs / 1000)}
        </span>
      ) : null}
    </Link>
  );

  const myListButton = (
    <Button
      variant="icon"
      size="icon"
      className="size-12"
      aria-pressed={myList.inList}
      aria-label={myList.inList ? "Remove from My List" : "Add to My List"}
      onClick={() => void myList.toggle()}
    >
      {myList.inList ? <CheckIcon strokeWidth={1.75} /> : <PlusIcon strokeWidth={1.75} />}
    </Button>
  );

  const progress =
    target.fraction === null ? null : (
      <div className={cn("flex items-center gap-3", phone ? "px-1" : "w-105")}>
        <div className="flex h-1 grow overflow-hidden rounded-xs bg-hairline">
          <div
            className="h-1 bg-accent"
            style={{ width: `${Math.round(target.fraction * 100)}%` }}
          />
        </div>
        {remaining === null ? null : (
          <span className="text-label/label text-text-muted">
            {facts(
              title.kind === "show" && title.nextEpisode !== null && phone
                ? `S${title.nextEpisode.seasonNumber}:E${title.nextEpisode.episodeNumber}`
                : null,
              formatRemaining(remaining),
            )}
          </span>
        )}
      </div>
    );

  const heading = (
    <div className="flex flex-col gap-3.5">
      {logo === undefined ? (
        <h1
          className={cn(
            "font-black text-text",
            phone
              ? "text-hero-card/11 tracking-display"
              : title.name.length > LONG_NAME
                ? "text-display/display tracking-display"
                : "text-hero/26 tracking-hero",
          )}
        >
          {phone || title.name.length <= LONG_NAME ? title.name.toUpperCase() : title.name}
        </h1>
      ) : (
        <img
          src={logo}
          alt={title.name}
          className={cn("object-contain object-left", phone ? "h-14 max-w-70" : "h-30 max-w-140")}
        />
      )}
      {title.tagline === null || phone ? null : (
        <p className="text-heading/6 font-light tracking-spread text-text uppercase">
          {title.tagline}
        </p>
      )}
    </div>
  );

  if (phone) {
    return (
      <div className="flex flex-col pb-36">
        <PhoneBackdrop backdrop={backdrop}>{heading}</PhoneBackdrop>
        <div className="flex flex-col gap-3.5 px-4 pt-1">
          {missing ? <MissingBanner title={title} canManage={canManage} phone /> : null}
          <p className="flex flex-wrap items-center gap-2 px-1 text-label/label text-text-muted">
            {facts(
              title.year,
              title.certification,
              title.kind === "show"
                ? plural(title.seasons.length, "season", "seasons")
                : title.runtimeMs === null
                  ? null
                  : formatRuntime(title.runtimeMs),
            )}
            {badges.slice(0, 2).map((badge) => (
              <Badge key={badge} className="h-4.5 border-text/40 px-1.25 text-tab/3">
                {badge}
              </Badge>
            ))}
          </p>
          {watch(false)}
          {progress}
          {title.overview === null ? null : (
            <p className="px-1 text-body/body text-text">{title.overview}</p>
          )}
        </div>
        <div className="flex justify-around px-6 pt-4.5 pb-1">
          <button
            type="button"
            aria-pressed={myList.inList}
            onClick={() => void myList.toggle()}
            className="flex w-26 cursor-pointer flex-col items-center gap-1.5 text-caption/caption text-text-muted"
          >
            {myList.inList ? (
              <CheckIcon className="size-5.5 text-text" strokeWidth={1.75} aria-hidden />
            ) : (
              <PlusIcon className="size-5.5 text-text" strokeWidth={1.75} aria-hidden />
            )}
            My List
          </button>
          {target.resuming ? (
            <Link
              to="/watch/$titleId"
              params={{ titleId: title.id }}
              search={watchSearch(target.episodeId, true)}
              className="flex w-26 flex-col items-center gap-1.5 text-caption/caption text-text-muted"
            >
              <RotateCcwIcon className="size-5.5 text-text" strokeWidth={1.75} aria-hidden />
              Play from start
            </Link>
          ) : null}
        </div>
        {title.kind === "show" ? <Episodes show={title} profileId={profileId} phone /> : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <div
        className="on-media relative isolate flex h-145 flex-col justify-end bg-dark-surface bg-cover bg-center px-16 pb-8"
        style={backdrop === undefined ? undefined : { backgroundImage: `url("${backdrop}")` }}
      >
        <div
          aria-hidden
          className="absolute inset-0 -z-10 bg-linear-to-r from-dark-bg/70 to-transparent to-60%"
        />
        <div
          aria-hidden
          className="absolute inset-0 -z-10 bg-linear-to-b from-dark-bg/55 via-transparent via-20% to-page to-92%"
        />
        <div className="mx-auto w-full max-w-content">{heading}</div>
      </div>
      <div className="mx-auto box-content flex w-full max-w-content gap-16 px-16 pb-12">
        <div className="flex w-200 shrink-0 flex-col gap-5">
          {missing ? <MissingBanner title={title} canManage={canManage} phone={false} /> : null}
          {factLine}
          <div className="flex items-center gap-3">
            {watch(false)}
            {target.resuming ? watch(true) : null}
            {myListButton}
          </div>
          {progress}
          {title.overview === null ? null : (
            <p className="w-170 pt-2 text-lead/6.75 text-text">{title.overview}</p>
          )}
          {file === undefined ? null : (
            <p className="flex items-center gap-2 pt-1 font-mono text-caption/caption text-text-muted">
              <HardDriveIcon className="size-3.5" strokeWidth={1.75} aria-hidden />
              {facts(file.versionName, file.probe.container, sizeLabel(file.sizeBytes))}
            </p>
          )}
        </div>
        <dl className="flex grow basis-0 flex-col gap-4.5 pt-0.5">
          {title.genres.length === 0 ? null : <Meta label="Genres">{title.genres.join(", ")}</Meta>}
          {tracks === null ? null : <Meta label="Audio · Subtitles">{tracks}</Meta>}
        </dl>
      </div>
      {title.kind === "show" ? <Episodes show={title} profileId={profileId} phone={false} /> : null}
    </div>
  );
}

function Meta({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-caption/caption font-semibold tracking-caps text-text-muted uppercase">
        {label}
      </dt>
      <dd className="text-body/body text-text">{children}</dd>
    </div>
  );
}

/** The phone backdrop: 300px of artwork with back and title, fading into the page. */
function PhoneBackdrop({
  backdrop,
  children,
}: {
  readonly backdrop: string | undefined;
  readonly children: ReactNode;
}) {
  const router = useRouter();

  return (
    <div
      className="on-media relative isolate flex h-75 flex-col justify-between bg-dark-surface-raised bg-cover bg-center pt-[max(env(safe-area-inset-top),--spacing(12))]"
      style={backdrop === undefined ? undefined : { backgroundImage: `url("${backdrop}")` }}
    >
      <div
        aria-hidden
        className="absolute inset-0 -z-10 bg-linear-to-b from-dark-bg/50 via-transparent via-30% to-page to-94%"
      />
      <div className="flex px-4">
        <button
          type="button"
          aria-label="Back"
          onClick={() => router.history.back()}
          className="flex size-10 cursor-pointer items-center justify-center rounded-pill border border-text/12 bg-glass backdrop-blur-xl"
        >
          <ChevronLeftIcon className="size-5" strokeWidth={1.75} aria-hidden />
        </button>
      </div>
      <div className="px-5 pb-2">{children}</div>
    </div>
  );
}

/** The warning when no file of the title is on disk, with a rescan for people who manage. */
function MissingBanner({
  title,
  canManage,
  phone,
}: {
  readonly title: TitleDetail;
  readonly canManage: boolean;
  readonly phone: boolean;
}) {
  const scan = useCommand("libraries.scan");
  const [pending, setPending] = useState(false);

  const rescan = async (): Promise<void> => {
    setPending(true);

    try {
      await scan({ libraryId: title.libraryId });
      toast.success("Scanning the library");
    } catch (cause) {
      toastFailure(cause);
    } finally {
      setPending(false);
    }
  };

  return (
    <div
      role="alert"
      className={cn(
        "flex items-start gap-3.5 rounded-control border border-warning/45 py-4 pr-4 pl-4.5",
        phone ? "flex-wrap" : "w-200",
      )}
    >
      <TriangleAlertIcon className="size-5 shrink-0 text-warning" strokeWidth={1.75} aria-hidden />
      <div className="flex min-w-0 grow basis-0 flex-col gap-1.5">
        <p className="text-body/5 font-semibold text-text">File not found</p>
        <p className="text-label/label text-text-muted">
          The share may be offline, or the file was moved.
        </p>
      </div>
      {canManage ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => void rescan()}
          className="flex h-9 shrink-0 cursor-pointer items-center gap-2 rounded-control bg-text pr-3.5 pl-3 text-label/caption font-semibold text-bg hover:bg-text/85 disabled:opacity-(--opacity-disabled)"
        >
          <RefreshCwIcon className="size-4" strokeWidth={1.75} aria-hidden />
          Rescan
        </button>
      ) : null}
    </div>
  );
}
