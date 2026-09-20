#!/usr/bin/env bash
# Try to screenshot Finder on a hosted macOS runner. usage: macos.sh <light|dark> <out-dir>
# Every step is best-effort: the point is to learn what the runner allows.
set -uo pipefail
THEME="${1:-light}"; OUT="${2:-out}"; mkdir -p "$OUT"
HERE="$(cd "$(dirname "$0")" && pwd)"
FIXTURE="$HOME/Documents/Your site"
bash "$HERE/make-fixture.sh" "$FIXTURE"

{ sw_vers; system_profiler SPDisplaysDataType; } > "$OUT/versions.txt" 2>&1

# Investigate a Retina (HiDPI) display: list the modes displayplacer can see and
# try to switch to a scaled one. Results are logged, the capture carries on.
{
  brew install jakehilborn/jakehilborn/displayplacer
  displayplacer list
  ID="$(displayplacer list | sed -n 's/.*Persistent screen id: //p' | head -1)"
  echo "screen id: $ID"
  displayplacer "id:$ID res:1024x768 hz:60 color_depth:8 scaling:on" || true
  sleep 3
  system_profiler SPDisplaysDataType
} > "$OUT/hidpi-probe.log" 2>&1

if [ "$THEME" = dark ]; then
  osascript -e 'tell application "System Events" to tell appearance preferences to set dark mode to true' >"$OUT/appearance.log" 2>&1 || true
else
  osascript -e 'tell application "System Events" to tell appearance preferences to set dark mode to false' >"$OUT/appearance.log" 2>&1 || true
fi
sleep 3

osascript >"$OUT/finder.log" 2>&1 <<OSA || true
tell application "Finder"
  activate
  close every window
  set w to make new Finder window to (POSIX file "$FIXTURE" as alias)
  set current view of w to list view
  set bounds of w to {60, 60, 960, 620}
  set sidebar width of w to 160
end tell
delay 1
tell application "System Events" to tell process "Finder"
  -- Hide Sidebar (View menu, Option-Cmd-S): we only want the folder contents
  keystroke "s" using {command down, option down}
  delay 1
  -- Cmd-Option-Right expands all folders in list view
  keystroke "a" using command down
  key code 124 using {option down}
end tell
delay 1
tell application "Finder" to set selection to {}
OSA
sleep 4
screencapture -x -R60,60,900,560 "$OUT/macos-$THEME.png" >"$OUT/screencapture.log" 2>&1 || true
ls -la "$OUT" >> "$OUT/screencapture.log"
