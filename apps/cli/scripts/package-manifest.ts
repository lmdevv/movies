/** The fields of a dependency's package.json that the third-party license list names. */
import { Schema } from "effect";

const PackageManifest = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  license: Schema.optional(Schema.String),
});

/** Parses a package.json's text, throwing when it lacks a name or version. */
export const decodePackageManifest = Schema.decodeUnknownSync(
  Schema.fromJsonString(PackageManifest),
);
