#!/usr/bin/env bash
# Compares same-named screenshots in two folders, such as two `ios matrix` runs, below the status
# bar (whose clock always differs). Prints `same` when no pixel moved by more than 2 of 255, which
# image encoding does on its own, and the largest change otherwise,
# and exits 1 when any differ, so "the iPhone did not change" is a command rather than a look.
#
#   compare-shots.sh BEFORE_DIR AFTER_DIR [GLOB]   GLOB defaults to *.png
set -euo pipefail
(($# >= 2)) || { sed -n '7p' "$0" >&2; exit 2; }
before="$1" after="$2" glob="${3:-*.png}" differ=0 status_bar=200
shopt -s nullglob
for file in "$after"/$glob; do
  name="$(basename "$file")"
  [[ -f "$before/$name" ]] || { echo "new   $name"; continue; }
  # The largest change of any pixel's brightness, out of 255. Image encoding moves some by 1.
  max="$(ffmpeg -loglevel info -i "$before/$name" -i "$file" -lavfi \
    "[0]crop=iw:ih-$status_bar:0:$status_bar[a];[1]crop=iw:ih-$status_bar:0:$status_bar[b];[a][b]blend=all_mode=difference,format=gray,signalstats,metadata=print:key=lavfi.signalstats.YMAX" \
    -f null - 2>&1 | sed -n 's/.*YMAX=\([0-9]*\).*/\1/p' | sort -n | tail -1)"
  if ((${max:-255} <= 2)); then echo "same  $name"; else echo "diff  $name (a pixel moved by $max of 255)"; differ=1; fi
done
exit "$differ"
