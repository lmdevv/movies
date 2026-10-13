/**
 * Functions for the media service, which signs in with `MEDIA_SERVICE_API_KEY` through the
 * `apikey` provider. Every function here requires the `media-service` scope, which only that key's
 * session holds; user sessions are refused, and the service session is refused everywhere else.
 */
import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { BACKUP_SYNC_LIMIT, BATCH_LIMIT } from "./lib/bounds";
import {
  inSequence,
  keepKnown,
  markFileMissing,
  searchTextOf,
  titleMetadata,
  upsertEpisode,
  upsertScannedItem,
} from "./lib/catalog";
import { fail } from "./lib/errors";
import { MAX_JOB_ATTEMPTS, requireLease, requireLeaseOf } from "./lib/jobs";
import { syncTitleGenres } from "./lib/genres";
import { CREDIT_LIMIT, creditsOf, personKeyOf, replaceCredits } from "./lib/people";
import { presentJob } from "./lib/present";
import { settleTrickplay } from "./lib/trickplay";
import {
  backupArchive,
  claimedJob,
  endedSession,
  indexedFile,
  job,
  jobProgress,
  leaseArgs,
  mediaLibrary,
  metadataTarget as metadataTargetResult,
  nullable,
  ok,
  page,
  pageArgs,
  personTarget as personTargetResult,
  playbackMode,
  resolvedFile,
  scannedCollection,
  scannedCredit,
  scannedEpisode,
  scannedItem,
  scannedPersonDetails,
  scannedTitle,
  sessionStatus as sessionStatusResult,
  trickplayManifest,
  upsertedFile,
} from "./lib/validators";
import { authorize } from "./lib/viewer";

const MIN_LEASE_MS = 5_000;

const MAX_LEASE_MS = 600_000;

const checkBatch = <Item>(items: ReadonlyArray<Item>): ReadonlyArray<Item> =>
  items.length > BATCH_LIMIT
    ? fail("invalid_args", `Send at most ${BATCH_LIMIT} items per call`)
    : items;

const checkLease = (leaseMs: number): number =>
  Number.isInteger(leaseMs) && leaseMs >= MIN_LEASE_MS && leaseMs <= MAX_LEASE_MS
    ? leaseMs
    : fail("invalid_args", "Leases last from 5 seconds to 10 minutes");

const presentMediaLibrary = (doc: Doc<"libraries">) => ({
  id: doc._id,
  name: doc.name,
  kind: doc.kind,
  roots: doc.roots,
});

const requireLibrary = async (
  ctx: MutationCtx,
  libraryId: Id<"libraries">,
): Promise<Doc<"libraries">> =>
  (await ctx.db.get(libraryId)) ?? fail("not_found", "No such library");

/** Pending jobs of each kind the worker is shown; trickplay jobs run one or two at a time. */
const PENDING_PER_KIND: ReadonlyArray<readonly [Doc<"jobs">["kind"], number]> = [
  ["scan", 50],
  ["metadata", 50],
  ["backup", 50],
  ["migration", 50],
  ["trickplay", 10],
];

/**
 * Jobs waiting for a worker, oldest first. Expired leases return here through a cron. Each kind
 * is read on its own, so a library's worth of queued scrub thumbnails never hides a scan or a
 * backup queued after them.
 */
export const pendingJobs = query({
  args: {},
  returns: v.array(job),
  handler: async (ctx) => {
    await authorize(ctx, "media-service");

    const byKind = await Promise.all(
      PENDING_PER_KIND.map(([kind, limit]) =>
        ctx.db
          .query("jobs")
          .withIndex("by_kind_status", (q) => q.eq("kind", kind).eq("status", "pending"))
          .take(limit),
      ),
    );

    return byKind
      .flat()
      .toSorted((left, right) => left._creationTime - right._creationTime)
      .map(presentJob);
  },
});

export const claimJob = mutation({
  args: { ...leaseArgs, leaseMs: v.number() },
  returns: v.union(v.null(), claimedJob),
  handler: async (ctx, { jobId, workerId, leaseMs }) => {
    await authorize(ctx, "media-service");
    const doc = await ctx.db.get(jobId);
    const now = Date.now();

    const claimable =
      doc !== null &&
      (doc.status === "pending" || (doc.status === "running" && (doc.leaseExpiresAt ?? 0) <= now));

    if (!claimable) return null;
    const leaseExpiresAt = now + checkLease(leaseMs);

    await ctx.db.patch(jobId, {
      status: "running",
      leaseOwner: workerId,
      leaseExpiresAt,
      attempts: doc.attempts + 1,
      startedAt: doc.startedAt ?? now,
    });

    const claimed = await ctx.db.get(jobId);

    if (claimed === null) return null;
    const library = doc.payload.kind === "scan" ? await ctx.db.get(doc.payload.libraryId) : null;

    return {
      job: presentJob(claimed),
      library: library === null ? null : presentMediaLibrary(library),
      leaseExpiresAt,
    };
  },
});

export const renewLease = mutation({
  args: { ...leaseArgs, leaseMs: v.number(), progress: v.optional(jobProgress) },
  returns: v.object({ leaseExpiresAt: v.number(), cancelled: v.boolean() }),
  handler: async (ctx, { jobId, workerId, leaseMs, progress }) => {
    await authorize(ctx, "media-service");
    const doc = await ctx.db.get(jobId);

    if (doc?.status === "cancelled" && doc.leaseOwner === workerId) {
      return { leaseExpiresAt: doc.leaseExpiresAt ?? 0, cancelled: true };
    }

    await requireLease(ctx, jobId, workerId);
    const leaseExpiresAt = Date.now() + checkLease(leaseMs);

    await ctx.db.patch(
      jobId,
      progress === undefined ? { leaseExpiresAt } : { leaseExpiresAt, progress },
    );

    return { leaseExpiresAt, cancelled: false };
  },
});

export const completeJob = mutation({
  args: { ...leaseArgs, message: v.optional(v.string()) },
  returns: ok,
  handler: async (ctx, { jobId, workerId, message }) => {
    await authorize(ctx, "media-service");
    const doc = await requireLease(ctx, jobId, workerId);
    const now = Date.now();

    await ctx.db.patch(jobId, {
      status: "succeeded",
      finishedAt: now,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      progress: { ...doc.progress, message: message ?? doc.progress.message },
    });

    if (doc.payload.kind === "scan" && (await ctx.db.get(doc.payload.libraryId)) !== null) {
      await ctx.db.patch(doc.payload.libraryId, { lastScanAt: now });
    }

    return { ok: true as const };
  },
});

export const failJob = mutation({
  args: { ...leaseArgs, error: v.string(), retry: v.boolean() },
  returns: ok,
  handler: async (ctx, { jobId, workerId, error, retry }) => {
    await authorize(ctx, "media-service");
    const doc = await requireLease(ctx, jobId, workerId);
    const again = retry && doc.attempts < MAX_JOB_ATTEMPTS;

    await ctx.db.patch(jobId, {
      status: again ? "pending" : "failed",
      error,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      finishedAt: again ? null : Date.now(),
    });

    if (!again) await settleTrickplay(ctx, doc, "failed");

    return { ok: true as const };
  },
});

export const libraries = query({
  args: {},
  returns: v.array(mediaLibrary),
  handler: async (ctx) => {
    await authorize(ctx, "media-service");
    const docs = await ctx.db.query("libraries").collect();

    return docs.map(presentMediaLibrary);
  },
});

export const fileIndex = query({
  args: { libraryId: v.id("libraries"), ...pageArgs },
  returns: page(indexedFile),
  handler: async (ctx, { libraryId, cursor, limit }) => {
    await authorize(ctx, "media-service");

    const result = await ctx.db
      .query("mediaFiles")
      .withIndex("by_library_path", (q) => q.eq("libraryId", libraryId))
      .paginate({
        numItems: Math.min(Math.max(1, Math.floor(limit ?? 100)), 100),
        cursor: cursor ?? null,
      });

    return {
      items: result.page.map((file) => ({
        path: file.path,
        sizeBytes: file.sizeBytes,
        mtimeMs: file.mtimeMs,
        missing: file.missing,
      })),
      nextCursor: result.isDone ? null : result.continueCursor,
    };
  },
});

export const upsertScanned = mutation({
  args: { libraryId: v.id("libraries"), items: v.array(scannedItem) },
  returns: v.array(upsertedFile),
  handler: async (ctx, { libraryId, items }) => {
    await authorize(ctx, "media-service");
    const library = await requireLibrary(ctx, libraryId);

    const inside = (path: string) =>
      !path.split("/").some((segment) => segment === ".." || segment === ".") &&
      library.roots.some(
        (root) => path === root || path.startsWith(root === "/" ? root : `${root}/`),
      );

    const outside = checkBatch(items).find((item) => !inside(item.file.path));

    if (outside !== undefined) {
      return fail("invalid_args", `${outside.file.path} is outside the library's folders`);
    }

    return inSequence(items, (item) => upsertScannedItem(ctx, library, item));
  },
});

export const markMissing = mutation({
  args: { libraryId: v.id("libraries"), paths: v.array(v.string()) },
  returns: v.object({ marked: v.number() }),
  handler: async (ctx, { libraryId, paths }) => {
    await authorize(ctx, "media-service");
    await requireLibrary(ctx, libraryId);

    const marked = await inSequence(checkBatch(paths), (path) =>
      markFileMissing(ctx, libraryId, path),
    );

    return { marked: marked.filter(Boolean).length };
  },
});

export const resolveFile = query({
  args: { fileId: v.id("mediaFiles") },
  returns: resolvedFile,
  handler: async (ctx, { fileId }) => {
    await authorize(ctx, "media-service");
    const file = await ctx.db.get(fileId);

    if (file === null) return fail("not_found", "No such file");
    const library = await ctx.db.get(file.libraryId);

    if (library === null) return fail("not_found", "This file's library was removed");

    return {
      fileId,
      libraryId: library._id,
      path: file.path,
      roots: library.roots,
      probe: file.probe,
      externalSubtitles: file.externalSubtitles,
      missing: file.missing,
    };
  },
});

export const sessionStatus = query({
  args: { sessionId: v.id("playbackSessions") },
  returns: sessionStatusResult,
  handler: async (ctx, { sessionId }) => {
    await authorize(ctx, "media-service");
    const session = await ctx.db.get(sessionId);

    if (session === null) return fail("not_found", "No such playback session");

    return { sessionId, status: session.status, fileId: session.fileId, endedAt: session.endedAt };
  },
});

/**
 * Sessions that ended after `after`, oldest first; the media service stops their streams and asks
 * again after the latest `endedAt` it saw. A page never splits one `endedAt`: a sign-out or a
 * restore ends many sessions in the same millisecond, and the ones past the limit would otherwise
 * be skipped by the next page.
 */
export const endedSessions = query({
  args: { after: v.number(), limit: v.optional(v.number()) },
  returns: v.array(endedSession),
  handler: async (ctx, { after, limit }) => {
    await authorize(ctx, "media-service");
    const wanted = Math.min(Math.max(1, Math.floor(limit ?? 100)), 200);

    const ended = await ctx.db
      .query("playbackSessions")
      .withIndex("by_status_ended", (q) => q.eq("status", "ended").gt("endedAt", after))
      .take(wanted);

    const last = ended.at(-1)?.endedAt ?? null;

    const ties =
      ended.length < wanted || last === null
        ? []
        : await ctx.db
            .query("playbackSessions")
            .withIndex("by_status_ended", (q) => q.eq("status", "ended").eq("endedAt", last))
            .collect();

    const unique = new Map([...ended, ...ties].map((session) => [session._id, session]));

    return [...unique.values()].flatMap((session) =>
      session.endedAt === null ? [] : [{ sessionId: session._id, endedAt: session.endedAt }],
    );
  },
});

export const recordPlaybackMode = mutation({
  args: { sessionId: v.id("playbackSessions"), mode: playbackMode },
  returns: ok,
  handler: async (ctx, { sessionId, mode }) => {
    await authorize(ctx, "media-service");

    if ((await ctx.db.get(sessionId)) === null)
      return fail("not_found", "No such playback session");
    await ctx.db.patch(sessionId, { mode });

    return { ok: true as const };
  },
});

export const metadataTarget = query({
  args: { titleId: v.id("titles") },
  returns: metadataTargetResult,
  handler: async (ctx, { titleId }) => {
    await authorize(ctx, "media-service");
    const title = await ctx.db.get(titleId);

    if (title === null) return fail("not_found", "No such title");

    const episodes = await ctx.db
      .query("episodes")
      .withIndex("by_title_order", (q) => q.eq("titleId", titleId))
      .collect();

    return {
      titleId,
      libraryId: title.libraryId,
      kind: title.kind,
      name: title.overrides?.name ?? title.name,
      year: title.overrides?.year ?? title.year,
      externalIds: title.externalIds,
      artwork: title.artwork,
      episodes: episodes.map((episode) => ({
        episodeId: episode._id,
        seasonNumber: episode.seasonNumber,
        episodeNumber: episode.episodeNumber,
      })),
    };
  },
});

/**
 * Writes fetched metadata during a metadata job. A job carrying a manual match marks the title
 * manual, so later scans keep its files and metadata.
 */
export const applyMetadata = mutation({
  args: {
    ...leaseArgs,
    titleId: v.id("titles"),
    title: scannedTitle,
    episodes: v.array(scannedEpisode),
  },
  returns: ok,
  handler: async (ctx, { jobId, workerId, titleId, title, episodes }) => {
    await authorize(ctx, "media-service");
    const doc = await requireLeaseOf(ctx, jobId, workerId, "metadata");

    if (doc.payload.titleId !== titleId)
      return fail("invalid_args", "This job is for another title");
    const current = await ctx.db.get(titleId);

    if (current === null) return fail("not_found", "No such title");
    const merged = keepKnown(title, current);
    const metadata = { ...titleMetadata(merged), kind: current.kind };

    await ctx.db.patch(titleId, {
      ...metadata,
      matchStatus: doc.payload.match === null ? merged.matchStatus : "manual",
      updatedAt: Date.now(),
      searchText: searchTextOf({ ...metadata, overrides: current.overrides }),
    });

    const updated = await ctx.db.get(titleId);

    if (updated !== null) await syncTitleGenres(ctx, updated);

    if (current.kind === "show") {
      await inSequence(checkBatch(episodes), (episode) => upsertEpisode(ctx, titleId, episode));
    }

    return { ok: true as const };
  },
});

/**
 * Whether a metadata write may change `title`: a scan may change any title an admin did not match
 * by hand; a metadata job holding its lease may change the title it is for.
 */
const mayWriteMetadata = async (
  ctx: MutationCtx,
  title: Doc<"titles">,
  lease: { readonly jobId: Id<"jobs">; readonly workerId: string } | undefined,
): Promise<boolean> => {
  if (lease === undefined) return title.matchStatus !== "manual";
  const held = await requireLeaseOf(ctx, lease.jobId, lease.workerId, "metadata");

  return held.payload.titleId === title._id
    ? true
    : fail("invalid_args", "This job is for another title");
};

const optionalLease = v.optional(v.object(leaseArgs));

export const applyCredits = mutation({
  args: {
    titleId: v.id("titles"),
    episodeId: nullable(v.id("episodes")),
    credits: v.array(scannedCredit),
    hash: v.string(),
    lease: optionalLease,
  },
  returns: v.object({
    written: v.boolean(),
    people: v.array(
      v.object({
        personId: v.id("people"),
        tmdbId: nullable(v.string()),
        needsDetails: v.boolean(),
      }),
    ),
  }),
  handler: async (ctx, { titleId, episodeId, credits, hash, lease }) => {
    await authorize(ctx, "media-service");

    if (credits.length > CREDIT_LIMIT) {
      return fail("invalid_args", `Send at most ${CREDIT_LIMIT} credits per call`);
    }

    const title = (await ctx.db.get(titleId)) ?? fail("not_found", "No such title");
    const episode = episodeId === null ? null : await ctx.db.get(episodeId);

    if (episodeId !== null && episode?.titleId !== titleId) {
      return fail("not_found", "No such episode of this title");
    }

    const stored = episode === null ? title.creditsHash : episode.creditsHash;

    if (stored === hash || !(await mayWriteMetadata(ctx, title, lease))) {
      return { written: false, people: [] };
    }

    // A refresh fills credits nobody wrote yet; it never replaces a scan's (often an NFO's cast,
    // which would only come back at the next scan). A hand-picked match replaces them.
    if (lease !== undefined && stored !== undefined) {
      const held = await requireLeaseOf(ctx, lease.jobId, lease.workerId, "metadata");

      if (held.payload.match === null) {
        // The people already credited still get their details fetched by the refresh.
        const rows = await creditsOf(ctx, titleId, episodeId, CREDIT_LIMIT);
        const people = await Promise.all(rows.map((row) => ctx.db.get(row.personId)));

        return {
          written: false,
          people: people.flatMap((person) =>
            person === null
              ? []
              : [
                  {
                    personId: person._id,
                    tmdbId: person.externalIds.tmdb,
                    needsDetails:
                      person.detailsFetchedAt === null && person.externalIds.tmdb !== null,
                  },
                ],
          ),
        };
      }
    }

    const people = await replaceCredits(ctx, titleId, episodeId, credits);

    if (episode === null) await ctx.db.patch(titleId, { creditsHash: hash });
    else await ctx.db.patch(episode._id, { creditsHash: hash });

    return {
      written: true,
      people: people.map((person) => ({
        personId: person._id,
        tmdbId: person.externalIds.tmdb,
        needsDetails: person.detailsFetchedAt === null && person.externalIds.tmdb !== null,
      })),
    };
  },
});

/** Where an automatically added member sorts: by year, so a film series reads in order. */
const positionOf = (title: Doc<"titles">): number => title.overrides?.year ?? title.year ?? 9999;

/**
 * Puts a title in the collection its metadata names, creating the collection on first sight, and
 * takes it out of any other collection its metadata put it in. A collection of the same name that
 * an import created is reused, so a TMDB collection and a Jellyfin box set become one.
 */
export const applyCollection = mutation({
  args: {
    titleId: v.id("titles"),
    collection: nullable(scannedCollection),
    hash: v.string(),
    lease: optionalLease,
  },
  returns: ok,
  handler: async (ctx, { titleId, collection, hash, lease }) => {
    await authorize(ctx, "media-service");
    const title = (await ctx.db.get(titleId)) ?? fail("not_found", "No such title");

    if (title.collectionHash === hash || !(await mayWriteMetadata(ctx, title, lease))) {
      return { ok: true as const };
    }

    await ctx.db.patch(titleId, { collectionHash: hash });
    const now = Date.now();

    const target =
      collection === null
        ? null
        : ((await ctx.db
            .query("collections")
            .withIndex("by_source_key", (q) => q.eq("sourceKey", collection.sourceKey))
            .first()) ??
          // A box set or NFO set of the same name joins it; another TMDB collection never does.
          (
            await ctx.db
              .query("collections")
              .withIndex("by_sort", (q) => q.eq("sortKey", collection.name.trim().toLowerCase()))
              .take(10)
          ).find((candidate) => !(candidate.sourceKey?.startsWith("tmdb:") ?? false)) ??
          null);

    const collectionId =
      collection === null
        ? null
        : target === null
          ? await ctx.db.insert("collections", {
              name: collection.name.trim(),
              sortKey: collection.name.trim().toLowerCase(),
              sourceKey: collection.sourceKey,
              createdAt: now,
              updatedAt: now,
              overview: collection.overview,
              poster: collection.poster,
              backdrop: collection.backdrop,
            })
          : target._id;

    if (collection !== null && target !== null) {
      await ctx.db.patch(target._id, {
        overview: collection.overview ?? target.overview ?? null,
        poster: collection.poster ?? target.poster ?? null,
        backdrop: collection.backdrop ?? target.backdrop ?? null,
        updatedAt: now,
      });
    }

    const memberships = await ctx.db
      .query("collectionItems")
      .withIndex("by_title", (q) => q.eq("titleId", titleId))
      .collect();

    await Promise.all(
      memberships.flatMap((member) =>
        member.source === "metadata" && member.collectionId !== collectionId
          ? [ctx.db.delete(member._id)]
          : [],
      ),
    );

    const member = memberships.find((entry) => entry.collectionId === collectionId);

    // An imported membership becomes the metadata one, so a later import that leaves the title out
    // of that collection no longer drops what the metadata says.
    if (member !== undefined && member.source !== "metadata") {
      await ctx.db.patch(member._id, { source: "metadata" });
    }

    if (collectionId !== null && member === undefined) {
      await ctx.db.insert("collectionItems", {
        collectionId,
        titleId,
        position: positionOf(title),
        source: "metadata",
      });
    }

    return { ok: true as const };
  },
});

export const personTarget = query({
  args: { personId: v.id("people") },
  returns: personTargetResult,
  handler: async (ctx, { personId }) => {
    await authorize(ctx, "media-service");
    const person = (await ctx.db.get(personId)) ?? fail("not_found", "No such person");

    return { personId, name: person.name, externalIds: person.externalIds };
  },
});

/** Writes a person's details during a person job, or a metadata job for top-billed people. */
export const applyPerson = mutation({
  args: { ...leaseArgs, personId: v.id("people"), details: scannedPersonDetails },
  returns: ok,
  handler: async (ctx, { jobId, workerId, personId, details }) => {
    await authorize(ctx, "media-service");
    const held = await requireLease(ctx, jobId, workerId);

    if (held.payload.kind !== "person" && held.payload.kind !== "metadata") {
      return fail("invalid_args", "This job is not a person or metadata job");
    }

    if (held.payload.kind === "person" && held.payload.personId !== personId) {
      return fail("invalid_args", "This job is for another person");
    }

    // A metadata job describes the people credited on its own title, and nobody else.
    if (held.payload.kind === "metadata") {
      const { titleId } = held.payload;

      const credited = await ctx.db
        .query("credits")
        .withIndex("by_title_episode", (q) => q.eq("titleId", titleId).eq("episodeId", null))
        .collect();

      if (!credited.some((row) => row.personId === personId)) {
        return fail("invalid_args", "This person is not credited on the job's title");
      }
    }

    const person = (await ctx.db.get(personId)) ?? fail("not_found", "No such person");

    // IDs already stored win, as they do for credits; the provider fills the ones missing.
    const externalIds = {
      tmdb: person.externalIds.tmdb ?? details.externalIds.tmdb,
      imdb: person.externalIds.imdb ?? details.externalIds.imdb,
      tvdb: person.externalIds.tvdb ?? details.externalIds.tvdb,
    };

    await ctx.db.patch(personId, {
      name: details.name,
      personKey: personKeyOf({ name: person.name, externalIds }),
      externalIds,
      profile: details.profile ?? person.profile,
      biography: details.biography,
      birthDate: details.birthDate,
      deathDate: details.deathDate,
      birthPlace: details.birthPlace,
      knownFor: details.knownFor,
      detailsFetchedAt: Date.now(),
      updatedAt: Date.now(),
    });

    return { ok: true as const };
  },
});

export const recordBackup = mutation({
  args: { ...leaseArgs, fileName: v.string(), sizeBytes: v.number() },
  returns: v.object({ backupId: v.id("backups") }),
  handler: async (ctx, { jobId, workerId, fileName, sizeBytes }) => {
    await authorize(ctx, "media-service");
    const doc = await requireLeaseOf(ctx, jobId, workerId, "backup");

    const backupId = await ctx.db.insert("backups", {
      fileName,
      sizeBytes,
      trigger: doc.payload.trigger,
      jobId,
    });

    return { backupId };
  },
});

/** The archive file of a backup, for a restore. */
export const backupFile = query({
  args: { backupId: v.id("backups") },
  returns: v.object({ fileName: v.string() }),
  handler: async (ctx, { backupId }) => {
    await authorize(ctx, "media-service");
    const doc = (await ctx.db.get(backupId)) ?? fail("not_found", "No such backup");

    return { fileName: doc.fileName };
  },
});

/**
 * Makes the backups table list exactly the archives in the media service's backup folder: rows
 * without a file go (retention pruned it), and files without a row are added (a restore replaced
 * the table with an older one, or an admin copied an archive in). Safe to repeat.
 */
export const syncBackups = mutation({
  args: { archives: v.array(backupArchive) },
  returns: v.object({ added: v.number(), removed: v.number() }),
  handler: async (ctx, { archives }) => {
    await authorize(ctx, "media-service");

    if (archives.length > BACKUP_SYNC_LIMIT) {
      return fail("invalid_args", `Send at most ${BACKUP_SYNC_LIMIT} archives`);
    }

    const rows = await ctx.db.query("backups").collect();
    const onDisk = new Set(archives.map((archive) => archive.fileName));
    const recorded = new Set(rows.map((row) => row.fileName));
    const stale = rows.filter((row) => !onDisk.has(row.fileName));
    const missing = archives.filter((archive) => !recorded.has(archive.fileName));

    await Promise.all(stale.map((row) => ctx.db.delete(row._id)));
    await Promise.all(missing.map((archive) => ctx.db.insert("backups", archive)));

    return { added: missing.length, removed: stale.length };
  },
});

/**
 * Records a file's finished scrub thumbnails during its trickplay job. A file whose state moved
 * on meanwhile (marked missing, or queued again after a change) keeps its state; the media
 * service's sweep deletes thumbnails nobody records.
 */
export const recordTrickplay = mutation({
  args: {
    ...leaseArgs,
    fileId: v.id("mediaFiles"),
    sizeBytes: v.number(),
    mtimeMs: v.number(),
    manifest: trickplayManifest,
  },
  returns: ok,
  handler: async (ctx, { jobId, workerId, fileId, sizeBytes, mtimeMs, manifest }) => {
    await authorize(ctx, "media-service");
    const doc = await requireLeaseOf(ctx, jobId, workerId, "trickplay");

    if (doc.payload.fileId !== fileId) return fail("invalid_args", "This job is for another file");
    const file = await ctx.db.get(fileId);

    if (file?.trickplay?.status === "pending" && file.trickplay.jobId === jobId) {
      await ctx.db.patch(fileId, {
        trickplay: { status: "ready", sizeBytes, mtimeMs, manifest },
      });
    }

    return { ok: true as const };
  },
});

/**
 * The thumbnail version each of `fileIds` still uses, for the media service's sweep of its
 * thumbnail folder: null for unknown IDs, removed or missing files, and files without ready
 * thumbnails. IDs come from folder names, so they are checked rather than validated.
 */
export const trickplayVersions = query({
  args: { fileIds: v.array(v.string()) },
  returns: v.array(v.object({ fileId: v.string(), version: nullable(v.string()) })),
  handler: async (ctx, { fileIds }) => {
    await authorize(ctx, "media-service");

    return Promise.all(
      checkBatch(fileIds).map(async (fileId) => {
        const id = ctx.db.normalizeId("mediaFiles", fileId);
        const file = id === null ? null : await ctx.db.get(id);

        const version =
          file === null || file.missing || file.trickplay?.status !== "ready"
            ? null
            : file.trickplay.manifest.version;

        return { fileId, version };
      }),
    );
  },
});
