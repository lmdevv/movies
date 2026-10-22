# Upstream

- **Source:** https://github.com/dmmulroy/anti-slop
- **Commit:** `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b` (installed 2026-10-10 with the
  `install-anti-slop` skill)
- **Path:** `skills/install-anti-slop/assets/anti-slop/` copied to `tools/oxlint/anti-slop/`
- **Verified:** the copy is byte-identical to that commit, apart from the deviations below.
- **Deviations:** comment cleanup and one named condition; behavior, licenses, and notices unchanged.
  - `rules/no-shape-in-symbol-names.ts`: removed the JSDoc on the private `isBorrowedMemberName`.
  - `vendor/eslint-stylistic/padding-line-between-statements.ts`: removed the JSDoc on private
    helpers and the line comments that narrated the code. The file's provenance line, the
    replica rationale with its links, and the JSCS note on IIFEs remain.
    The autofix condition is named `commentSplitsPadding`; its expression is unchanged.

  `vendor/eslint-stylistic/` keeps its own license and provenance.
- **Updating:** run the global `install-anti-slop` skill; it merges upstream changes and keeps
  local edits.
