#!/usr/bin/env bash
# Compares same-named screenshots in two folders, such as two `ios matrix` runs, below the status
# bar (whose clock always differs). Prints `same` for pixel-identical files and the PSNR otherwise,
# and exits 1 when any differ, so "the iPhone did not change" is a command rather than a look.
#
#   compare-shots.sh BEFORE_DIR AFTER_DIR [GLOB]   GLOB defaults to *.png
set -euo pipefail
(($# >= 2)) || { sed -n '6p' "$0" >&2; exit 2; }
before="$1" after="$2" glob="${3:-*.png}" differ=0 status_bar=200
shopt -s nullglob
for file in "$after"/$glob; do
  name="$(basename "$file")"
  [[ -f "$before/$name" ]] || { echo "new   $name"; continue; }
  psnr="$(ffmpeg -loglevel info -i "$before/$name" -i "$file" -lavfi \
    "[0]crop=iw:ih-$status_bar:0:$status_bar[a];[1]crop=iw:ih-$status_bar:0:$status_bar[b];[a][b]psnr" \
    -f null - 2>&1 | sed -n 's/.*average:\([^ ]*\).*/\1/p')"
  if [[ "$psnr" == inf ]]; then echo "same  $name"; else echo "diff  $name (PSNR $psnr)"; differ=1; fi
done
exit "$differ"
