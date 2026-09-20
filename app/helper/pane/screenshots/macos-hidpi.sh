#!/usr/bin/env bash
# Experiments in getting a Retina (2x) Finder capture on a hosted macOS runner.
# usage: macos-hidpi.sh <modes|virtual> <out-dir>
set -uo pipefail
EXP="${1:-modes}"; OUT="${2:-out}"; mkdir -p "$OUT"
HERE="$(cd "$(dirname "$0")" && pwd)"
FIXTURE="$HOME/Documents/Your site"
bash "$HERE/make-fixture.sh" "$FIXTURE"
LOG="$OUT/$EXP.log"; exec > >(tee -a "$LOG") 2>&1

clang -fobjc-arc "$HERE/hidpi.m" -framework Foundation -framework CoreGraphics -o /tmp/hidpi || { echo "compile failed"; exit 0; }
echo "== before"; system_profiler SPDisplaysDataType; /tmp/hidpi list

case "$EXP" in
  modes)
    /tmp/hidpi sethidpi 1024 || /tmp/hidpi sethidpi 800 || true
    sleep 4
    ;;
  virtual)
    /tmp/hidpi virtual 1024 768 240 > "$OUT/virtual-tool.log" 2>&1 &
    sleep 8; cat "$OUT/virtual-tool.log"
    echo "== after"; system_profiler SPDisplaysDataType; /tmp/hidpi list
    ;;
esac

osascript <<OSA || true
tell application "Finder"
  activate
  close every window
  set w to make new Finder window to (POSIX file "$FIXTURE" as alias)
  set current view of w to list view
  set bounds of w to {100, 100, 700, 560}
end tell
OSA
sleep 4
screencapture -x "$OUT/$EXP-full.png"
screencapture -x -R0,0,1024,768 "$OUT/$EXP-region.png"
for f in "$OUT"/*.png; do echo "$f: $(sips -g pixelWidth -g pixelHeight "$f" | tail -2 | tr '\n' ' ')"; done
