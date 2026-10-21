#!/usr/bin/env bash
# Prints the release version and fails unless every workspace package carries it: the image, the
# Nix packages, the npm package, and the release binaries all report it. Given a release tag, also
# fails unless the tag names that version.
#
#   scripts/check-version.sh            # 0.2.0
#   scripts/check-version.sh v0.2.0     # the release workflows, with the pushed tag
set -euo pipefail

cd "$(dirname "$0")/.."

mapfile -t manifests < <(git ls-files -- ':(glob)apps/*/package.json' ':(glob)packages/*/package.json')

node - "${1:-}" "${manifests[@]}" <<'EOF'
const { readFileSync } = require("node:fs");

const [tag, ...manifests] = process.argv.slice(2);
const versionOf = (path) => JSON.parse(readFileSync(path, "utf8")).version;
const version = versionOf("packages/backend/package.json");
const failures = manifests
  .filter((path) => versionOf(path) !== version)
  .map((path) => `${path} is ${versionOf(path)}, not ${version} (packages/backend/package.json)`);

if (tag !== "" && tag !== `v${version}`) {
  failures.push(`tag ${tag} does not name the package version ${version}`);
}

for (const failure of failures) console.error(`check-version: ${failure}`);
if (failures.length > 0) process.exit(1);
console.log(version);
EOF
