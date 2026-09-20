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

# Mild grey desktop so the window's shadow is visible
python3 - "$OUT/grey.png" <<'PY'
import sys, zlib, struct
w = h = 64
raw = b"".join(b"\x00" + bytes([200, 200, 200]) * w for _ in range(h))
def chunk(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))
open(sys.argv[1], "wb").write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))
PY
osascript -e "tell application \"Finder\" to set desktop picture to POSIX file \"$OUT/grey.png\"" >"$OUT/wallpaper.log" 2>&1 || true
sleep 2
# Trim the Finder toolbar to back/forward, the view switcher and search: drop
# the arrange, share, tag and action buttons. Identifiers are Finder's own.
PLIST="$HOME/Library/Preferences/com.apple.finder.plist"
{
  echo "before:"; defaults read com.apple.finder "NSToolbar Configuration Browser"
  PB=/usr/libexec/PlistBuddy
  $PB -c 'Delete ":NSToolbar Configuration Browser"' "$PLIST" || true
  $PB -c 'Add ":NSToolbar Configuration Browser" dict' "$PLIST"
  $PB -c 'Add ":NSToolbar Configuration Browser:TB Display Mode" integer 2' "$PLIST"
  $PB -c 'Add ":NSToolbar Configuration Browser:TB Icon Size Mode" integer 1' "$PLIST"
  $PB -c 'Add ":NSToolbar Configuration Browser:TB Is Shown" integer 1' "$PLIST"
  $PB -c 'Add ":NSToolbar Configuration Browser:TB Item Identifiers" array' "$PLIST"
  i=0
  for id in com.apple.finder.BACK NSToolbarFlexibleSpaceItem com.apple.finder.SWCH com.apple.finder.SRCH; do
    $PB -c "Add \":NSToolbar Configuration Browser:TB Item Identifiers:$i\" string $id" "$PLIST"; i=$((i+1))
  done
  killall cfprefsd; killall Finder; sleep 4
  echo "after:"; defaults read com.apple.finder "NSToolbar Configuration Browser"
} > "$OUT/toolbar.log" 2>&1

osascript >"$OUT/finder.log" 2>&1 <<OSA || true
tell application "Finder"
  activate
  close every window
  set w to make new Finder window to (POSIX file "$FIXTURE" as alias)
  set current view of w to list view
  set bounds of w to {100, 100, 920, 620}
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
screencapture -x -R40,40,940,640 "$OUT/macos-$THEME.png" >"$OUT/screencapture.log" 2>&1 || true
rm -f "$OUT/grey.png"; ls -la "$OUT" >> "$OUT/screencapture.log"
