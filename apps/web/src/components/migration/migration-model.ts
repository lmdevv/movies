/**
 * What only the web app's migration screens hold: the Importing screen's phase labels and the
 * Connect form. How a source failure reads, which profile each source user's history goes to, how
 * far an import has come, and folder mappings are shared with the iOS app
 * (`@movies/contracts/migration-plan`).
 */
import type { MigrationSource } from "@movies/contracts/models/jobs";
import type { MigrationPhase } from "@movies/contracts/models/migration";

/** What the Importing screen says each phase is doing. */
export const PHASE_LABELS: Readonly<Record<MigrationPhase, string>> = {
  libraries: "Adding libraries",
  scanning: "Scanning new folders",
  watchState: "Watched status",
  collections: "Collections",
  overrides: "Title and artwork edits",
  done: "Finishing",
};

/**
 * What the admin typed on Connect. It stays in the page's memory only, so Review can reconnect
 * with new folder mappings and Back returns to a filled form.
 */
export interface SourceForm {
  readonly source: MigrationSource;
  readonly url: string;
  /** A Jellyfin API key or a Plex token. Never stored, logged, or put in the URL. */
  readonly token: string;
}

/** An empty Connect form for Jellyfin. */
export const EMPTY_FORM: SourceForm = { source: "jellyfin", url: "", token: "" };
