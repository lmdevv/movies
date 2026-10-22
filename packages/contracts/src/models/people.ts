import { Schema } from "effect";

import { PersonId } from "../ids";
import { CreditKind, ExternalIds, TitleCard } from "./catalog";

/** One title a person is credited on, with what they did there. */
export const PersonCredit = Schema.Struct({
  title: TitleCard,
  kind: CreditKind,
  /** The character an actor plays, or a crew member's job. */
  role: Schema.NullOr(Schema.String),
  /** For guest stars: how many episodes of the show credit them. */
  episodeCount: Schema.Int,
});

/** One title a person is credited on. */
export interface PersonCredit extends Schema.Schema.Type<typeof PersonCredit> {}

/** Everything a person page shows. */
export const PersonDetail = Schema.Struct({
  id: PersonId,
  name: Schema.String,
  /** The person's photo as an artwork key. */
  profile: Schema.NullOr(Schema.String),
  externalIds: ExternalIds,
  biography: Schema.NullOr(Schema.String),
  /** `YYYY-MM-DD`. */
  birthDate: Schema.NullOr(Schema.String),
  /** `YYYY-MM-DD`. */
  deathDate: Schema.NullOr(Schema.String),
  birthPlace: Schema.NullOr(Schema.String),
  /** The department they are best known for, such as `Acting`. */
  knownFor: Schema.NullOr(Schema.String),
  /**
   * Biography and dates have not been fetched yet; `people.requestDetails` queues the fetch, and
   * this query updates when it lands.
   */
  detailsPending: Schema.Boolean,
  /** The titles the profile may see, newest first. */
  credits: Schema.Array(PersonCredit),
});

/** Everything a person page shows. */
export interface PersonDetail extends Schema.Schema.Type<typeof PersonDetail> {}
