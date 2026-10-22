import { Match, Option, Schema } from "effect";

import type { ProfileId, UserId } from "./ids";
import type { MigrationSource } from "./models/jobs";
import type {
  MigrationConnection,
  MigrationPhase,
  MigrationReport,
  MigrationRun,
  MigrationSourceFailure,
  UserMapping,
} from "./models/migration";
import { PathMapping } from "./models/migration";

/** Display names of the sources. Emby is not offered. */
export const SOURCE_NAMES: Readonly<Record<MigrationSource, string>> = {
  jellyfin: "Jellyfin",
  plex: "Plex",
};

/** The connect form's field a source failure is shown under, and the line shown there. */
export interface FailureLine {
  readonly field: "url" | "token";
  readonly message: string;
}

/** Where a failure to use `source` shows on Connect, and what it says, in both apps. */
export const failureLine = (
  failure: MigrationSourceFailure,
  source: MigrationSource,
): FailureLine => {
  const name = SOURCE_NAMES[source];
  const credential = source === "plex" ? "token" : "API key";

  return Match.value(failure.reason).pipe(
    Match.when("auth_failed", (): FailureLine => ({
      field: "token",
      message: `${name} didn’t accept this ${credential}.`,
    })),
    Match.when("not_admin", (): FailureLine => ({
      field: "token",
      message: `This ${credential} can’t read every user. Use an administrator’s.`,
    })),
    Match.when("unreachable", (): FailureLine => ({
      field: "url",
      message: "Nothing answered at this address.",
    })),
    Match.when("unexpected_response", (): FailureLine => ({
      field: "url",
      message: `This address doesn’t answer like a ${name} server.`,
    })),
    Match.when("version_unsupported", (): FailureLine => ({
      field: "url",
      message: failure.message,
    })),
    Match.exhaustive,
  );
};

/** The choice that skips a source user. */
export const SKIP = "skip";

/** A profile choice for a source user: a profile ID, or {@link SKIP}. */
export type UserChoice = ProfileId | typeof SKIP;

/** A profile a source user's history can go to, as the Review screen lists it. */
export interface ProfileOption {
  readonly value: UserChoice;
  readonly label: string;
}

interface OwnProfile {
  readonly id: ProfileId;
  readonly name: string;
}

interface Account {
  readonly id: UserId;
  readonly name: string;
}

/** One source user on the Review screen: who it is, where its history goes, and the choices. */
export interface UserRow {
  readonly sourceUserId: string;
  readonly name: string;
  readonly choice: UserChoice;
  readonly options: ReadonlyArray<ProfileOption>;
}

/**
 * The Review screen's user rows. Each row offers the profile connect suggested (another account's,
 * labeled with its account name), every profile of the signed-in account, and skipping, labeled
 * `skipLabel` in the app's own case. The current choice is the dry run's.
 */
export const userRows = (
  connection: MigrationConnection,
  report: MigrationReport,
  own: ReadonlyArray<OwnProfile>,
  accounts: ReadonlyArray<Account>,
  skipLabel: string,
): ReadonlyArray<UserRow> =>
  connection.users.map((user): UserRow => {
    const planned = report.users.find((each) => each.sourceUserId === user.sourceUserId);

    const ownOptions = own.map((profile): ProfileOption => ({
      value: profile.id,
      label: profile.name,
    }));

    const { suggestion } = user;

    const suggested: ReadonlyArray<ProfileOption> =
      suggestion.kind === "profile" && !own.some((profile) => profile.id === suggestion.profileId)
        ? [
            {
              value: suggestion.profileId,
              label:
                accounts.find((account) => account.id === suggestion.userId)?.name ?? "Suggested",
            },
          ]
        : [];

    return {
      sourceUserId: user.sourceUserId,
      name: user.name,
      choice: planned?.profileId ?? SKIP,
      options: [...suggested, ...ownOptions, { value: SKIP, label: skipLabel }],
    };
  });

/** The dry run's mappings as they stand, with `sourceUserId` changed to `choice` when given. */
export const mappingsFor = (
  rows: ReadonlyArray<UserRow>,
  change?: { readonly sourceUserId: string; readonly choice: UserChoice },
): ReadonlyArray<UserMapping> =>
  rows.map((row) => {
    const next = row.sourceUserId === change?.sourceUserId ? change.choice : row.choice;

    return { sourceUserId: row.sourceUserId, profileId: next === SKIP ? null : next };
  });

const PHASE_WEIGHTS: ReadonlyArray<readonly [MigrationPhase, number]> = [
  ["libraries", 0.05],
  ["scanning", 0.25],
  ["watchState", 0.55],
  ["collections", 0.05],
  ["overrides", 0.1],
];

/**
 * How far an import has come, from 0 to 1, across all its phases. A finished import is complete;
 * a phase without a known total counts as just started.
 */
export const importFraction = (run: MigrationRun): number => {
  if (run.job.status === "succeeded" || run.phase === "done") return 1;

  const index = PHASE_WEIGHTS.findIndex(([phase]) => phase === run.phase);
  const before = PHASE_WEIGHTS.slice(0, index).reduce((sum, [, weight]) => sum + weight, 0);
  const weight = PHASE_WEIGHTS[index]?.[1] ?? 0;
  const { done, total } = run.job.progress;
  const within = total === null || total <= 0 ? 0 : Math.min(1, Math.max(0, done / total));

  return Math.min(1, before + weight * within);
};

/**
 * Whole minutes left at the pace so far, at least 1; null until there is a pace (2% done) and once
 * the import is complete.
 */
export const importMinutesLeft = (
  run: MigrationRun,
  fraction: number,
  now: number,
): number | null => {
  if (run.job.startedAt === null || fraction < 0.02 || fraction >= 1) return null;

  const elapsed = Math.max(0, now - run.job.startedAt);

  return Math.max(1, Math.round((elapsed / fraction - elapsed) / 60_000));
};

const decodeMapping = Schema.decodeUnknownOption(PathMapping);

/**
 * The mappings to reconnect with after mapping source folder `from` to the local folder `to`: the
 * ones given at connect, with any for the same folder replaced. Inferred mappings are left out, as
 * connect infers them again. None when `to` is not a full local path.
 */
export const mappingsWith = (
  applied: MigrationConnection["pathMappings"],
  from: string,
  to: string,
): Option.Option<ReadonlyArray<PathMapping>> => {
  const kept: ReadonlyArray<PathMapping> = applied
    .filter((mapping) => !mapping.inferred && mapping.from !== from)
    .map((mapping) => ({ from: mapping.from, to: mapping.to }));

  return decodeMapping({ from, to: to.trim() }).pipe(Option.map((added) => kept.concat(added)));
};
