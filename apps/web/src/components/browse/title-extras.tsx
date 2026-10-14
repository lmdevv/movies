/**
 * The richer parts of a title's page: scores, provider links, credit lines, the cast and crew row
 * with round photos, the trailer dialog, the collection the title belongs to, and More like this.
 */
import type { CollectionId, ProfileId, TitleId } from "@movies/contracts/ids";
import type {
  Credit,
  CreditKind,
  Ratings,
  TitleDetail,
  Trailer,
} from "@movies/contracts/models/catalog";
import { useCommandQuery } from "@movies/sdk/react";
import { Avatar } from "@movies/ui/components/avatar";
import { buttonVariants } from "@movies/ui/components/button-variants";
import { MediaRow } from "@movies/ui/components/media-row";
import { cn } from "@movies/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import { ArrowUpRightIcon, ClapperboardIcon, StarIcon } from "lucide-react";
import { Fragment, Suspense, lazy, useState } from "react";

import { artworkUrl } from "@/lib/artwork";
import type { ExternalLink } from "@/lib/metadata";
import { creditLines, creditRole, scoresOf, trailerEmbedUrl } from "@/lib/metadata";

import { TitleLandscapeCard, TitlePosterCard } from "./title-cards";

const loadTrailerDialog = () => import("./trailer-dialog");

const preloadTrailerDialog = (): void => {
  void loadTrailerDialog();
};

const TrailerDialog = lazy(async () => ({ default: (await loadTrailerDialog()).TrailerDialog }));

/** People the cast row shows: the billed cast, then the crew who made the title. */
const CAST_ROW_LIMIT = 24;

/** `IMDb 7.9 · RT 88% · MC 73 · TMDB 7.1`, each score labeled for screen readers. */
export function Scores({
  ratings,
  className,
}: {
  readonly ratings: Ratings;
  readonly className?: string;
}) {
  const scores = scoresOf(ratings);

  if (scores.length === 0) return null;

  return (
    <ul
      aria-label="Ratings"
      className={cn("flex flex-wrap items-center gap-x-4 gap-y-1.5", className)}
    >
      {scores.map((score) => (
        <li
          key={score.site}
          aria-label={`${score.label} ${score.value}`}
          className="flex items-center gap-1.5 text-body/body text-text"
        >
          {score.site === "imdb" ? (
            <StarIcon className="size-4 fill-current text-warning" strokeWidth={1.75} aria-hidden />
          ) : null}
          <span
            aria-hidden
            className="text-caption/caption font-semibold tracking-caps text-text-muted"
          >
            {score.mark}
          </span>
          <span aria-hidden className="font-semibold">
            {score.value}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Links out to IMDb, TMDB, and TVDB, opened in a new tab without a referrer. */
export function ExternalLinks({ links }: { readonly links: ReadonlyArray<ExternalLink> }) {
  if (links.length === 0) return null;

  return (
    <ul className="flex flex-wrap items-center gap-3">
      {links.map((link) => (
        <li key={link.label}>
          <a
            href={link.href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-label/label font-semibold text-text-muted transition-colors hover:text-text"
          >
            {link.label}
            <ArrowUpRightIcon className="size-3.5" strokeWidth={1.75} aria-hidden />
          </a>
        </li>
      ))}
    </ul>
  );
}

/** Names that link to people's pages, joined with commas. */
export function PeopleLinks({ people }: { readonly people: ReadonlyArray<Credit> }) {
  return (
    <>
      {people.map((person, index) => (
        <Fragment key={person.personId}>
          {index === 0 ? null : ", "}
          <Link
            to="/person/$personId"
            params={{ personId: person.personId }}
            className="underline-offset-4 hover:underline"
          >
            {person.name}
          </Link>
        </Fragment>
      ))}
    </>
  );
}

/** `Directed by …` lines for the kinds given, such as the creators and directors under a title. */
export function CreditSummary({
  credits,
  kinds,
  className,
}: {
  readonly credits: ReadonlyArray<Credit>;
  readonly kinds: ReadonlyArray<CreditKind>;
  readonly className?: string;
}) {
  const lines = creditLines(credits, kinds);

  if (lines.length === 0) return null;

  return (
    <div className={cn("flex flex-col gap-1 text-body/body text-text", className)}>
      {lines.map((line) => (
        <p key={line.heading}>
          <span className="text-text-muted">{line.heading} </span>
          <PeopleLinks people={line.people} />
        </p>
      ))}
    </div>
  );
}

/** A round photo with a name and what they did, linking to the person's page. */
function PersonCard({
  personId,
  name,
  role,
  profile,
}: {
  readonly personId: Credit["personId"];
  readonly name: string;
  readonly role: string | null;
  readonly profile: string | null;
}) {
  return (
    <Link
      to="/person/$personId"
      params={{ personId }}
      className="group/person flex w-24 shrink-0 snap-start flex-col items-center gap-2 rounded-control text-center"
    >
      <Avatar
        name={name}
        image={artworkUrl(profile, "thumb")}
        size="md"
        round
        centered
        decorative
        className="transition-opacity group-hover/person:opacity-85"
      />
      <span className="flex flex-col gap-0.5">
        <span className="line-clamp-2 text-label/4 font-semibold text-text">{name}</span>
        {role === null ? null : (
          <span className="line-clamp-2 text-caption/4 text-text-muted">{role}</span>
        )}
      </span>
    </Link>
  );
}

/** An actor's character, or a crew member's job such as `Director`. */
const roleOf = (credit: Credit): string | null =>
  credit.kind === "actor" || credit.kind === "guest-star"
    ? credit.role
    : creditRole({ kind: credit.kind, role: credit.role, episodeCount: 0 });

/** The cast and crew row: billed actors first, then who made it. */
export function CastAndCrew({ title }: { readonly title: TitleDetail }) {
  const seen = new Set<string>();

  const people = [...title.cast, ...title.crew]
    .filter((credit) => {
      const key = `${credit.personId}:${credit.kind}`;

      if (seen.has(key)) return false;
      seen.add(key);

      return true;
    })
    .slice(0, CAST_ROW_LIMIT);

  if (people.length === 0) return null;

  return (
    <MediaRow title="Cast & crew">
      {people.map((credit) => (
        <PersonCard
          key={`${credit.personId}:${credit.kind}`}
          personId={credit.personId}
          name={credit.name}
          role={roleOf(credit)}
          profile={credit.profile}
        />
      ))}
    </MediaRow>
  );
}

/** The trailer button and the dialog that plays it from YouTube's cookieless player. */
export function TrailerButton({
  trailer,
  name,
  phone,
}: {
  readonly trailer: Trailer;
  readonly name: string;
  readonly phone: boolean;
}) {
  const [open, setOpen] = useState(false);
  // The dialog loads on the first open (or as the pointer or focus reaches the button) and then
  // stays mounted, so closing still animates.
  const [opened, setOpened] = useState(false);
  const src = trailerEmbedUrl(trailer.key);

  if (src === undefined) return null;

  return (
    <>
      <button
        type="button"
        onPointerEnter={preloadTrailerDialog}
        onFocus={preloadTrailerDialog}
        onClick={() => {
          setOpened(true);
          setOpen(true);
        }}
        className={
          phone
            ? "flex w-26 cursor-pointer flex-col items-center gap-1.5 text-caption/caption text-text-muted"
            : buttonVariants({ variant: "secondary", size: "lg" })
        }
      >
        <ClapperboardIcon
          className={phone ? "size-5.5 text-text" : undefined}
          strokeWidth={1.75}
          aria-hidden
        />
        Trailer
      </button>
      {opened ? (
        <Suspense fallback={null}>
          <TrailerDialog
            open={open}
            onOpenChange={setOpen}
            title={trailer.name ?? `${name} trailer`}
            frameTitle={`${name} trailer`}
            src={src}
          />
        </Suspense>
      ) : null}
    </>
  );
}

/** "Part of the Alien Collection": the other titles of the collection, in order. */
export function CollectionRow({
  profileId,
  collectionId,
  titleId,
  phone,
}: {
  readonly profileId: ProfileId;
  readonly collectionId: CollectionId;
  readonly titleId: TitleId;
  readonly phone: boolean;
}) {
  const collection = useCommandQuery("collections.get", { profileId, collectionId });

  if (collection.status !== "success" || collection.data.titles.length < 2) return null;

  return (
    <MediaRow
      title={`Part of ${collection.data.name}`}
      seeAll={<Link to="/collection/$collectionId" params={{ collectionId }} />}
    >
      {collection.data.titles.map((title) =>
        phone ? (
          <TitleLandscapeCard key={title.id} title={title} size="phone" />
        ) : (
          <TitlePosterCard
            key={title.id}
            title={title}
            badge={title.id === titleId ? "Viewing" : undefined}
          />
        ),
      )}
    </MediaRow>
  );
}

/** More like this: recommendations and look-alikes the profile may see. */
export function MoreLikeThis({
  profileId,
  titleId,
  phone,
}: {
  readonly profileId: ProfileId;
  readonly titleId: TitleId;
  readonly phone: boolean;
}) {
  const similar = useCommandQuery("titles.similar", { profileId, titleId });

  if (similar.status !== "success" || similar.data.length === 0) return null;

  return (
    <MediaRow title="More like this">
      {similar.data.map((title) =>
        phone ? (
          <TitleLandscapeCard key={title.id} title={title} size="phone" />
        ) : (
          <TitlePosterCard key={title.id} title={title} />
        ),
      )}
    </MediaRow>
  );
}
