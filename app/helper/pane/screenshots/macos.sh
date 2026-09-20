#!/usr/bin/env bash
# Try to screenshot Finder on a hosted macOS runner. usage: macos.sh <light|dark> <out-dir>
# Every step is best-effort: the point is to learn what the runner allows.
set -uo pipefail
THEME="${1:-light}"; OUT="${2:-out}"; SCALE="${3:-1}"; mkdir -p "$OUT"
SUFFIX=""; [ "$SCALE" != 1 ] && SUFFIX="@${SCALE}x"
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

# Retina: the runner's display has no HiDPI modes, so create a HiDPI virtual
# display with the private CGVirtualDisplay API and make it the main display.
if [ "$SCALE" = 2 ]; then
  clang -fobjc-arc "$HERE/hidpi.m" -framework Foundation -framework CoreGraphics -o /tmp/hidpi >"$OUT/hidpi.log" 2>&1
  /tmp/hidpi virtual 1024 768 600 >>"$OUT/hidpi.log" 2>&1 &
  sleep 8
fi

# 50% grey desktop, which makes the window's drop shadow easy to see so the window's shadow is visible. Finder won't set a
# wallpaper for us here, so paint a borderless desktop-level window instead.
osascript -l JavaScript >"$OUT/wallpaper.log" 2>&1 <<'JXA' &
ObjC.import('Cocoa');
const app = $.NSApplication.sharedApplication;
app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
const win = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer($.NSScreen.mainScreen.frame, 0, 2, false);
win.backgroundColor = $.NSColor.colorWithSRGBRedGreenBlueAlpha(0.5, 0.5, 0.5, 1);
win.level = -2147483623; // kCGDesktopWindowLevel
win.orderFront(null);
$.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(600));
JXA
sleep 3
defaults write -g AppleShowScrollBars -string WhenScrolling
# Trim the Finder toolbar to just back/forward (the window title stays): drop
# the view switcher, search, arrange, share, tag and action buttons. Identifiers are Finder's own.
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
  for id in com.apple.finder.BACK; do
    $PB -c "Add \":NSToolbar Configuration Browser:TB Item Identifiers:$i\" string $id" "$PLIST"; i=$((i+1))
  done
  # Standard list view column widths (used by any folder without its own .DS_Store):
  # a longer Name, Date Modified/Size narrow enough for Finder's short date format,
  # Kind hidden.
  echo "standard list view settings before:"; defaults read com.apple.finder FK_StandardViewSettings
  # The defaults don't exist on a fresh runner, so create each dictionary level first.
  # Modern macOS reads ExtendedListViewSettingsV2; older versions ListViewSettings.
  mkdict() { $PB -c "Add $1 dict" "$PLIST" 2>/dev/null || true; }
  mkdict ":FK_StandardViewSettings"
  for view in ListViewSettings ExtendedListViewSettingsV2; do
    mkdict ":FK_StandardViewSettings:$view"
    mkdict ":FK_StandardViewSettings:$view:columns"
    for col in name dateModified size kind; do mkdict ":FK_StandardViewSettings:$view:columns:$col"; done
    setcol() {  # column key, property, integer value
      K=":FK_StandardViewSettings:$view:columns:$1:$2"
      $PB -c "Set $K $3" "$PLIST" 2>/dev/null || $PB -c "Add $K integer $3" "$PLIST"
    }
    setcol name width 270; setcol name visible 1; setcol name index 0; setcol name ascending 1
    setcol dateModified width 104; setcol dateModified visible 1; setcol dateModified index 1
    setcol size width 70; setcol size visible 1; setcol size index 2
    setcol kind visible 0; setcol kind index 3
  done
  killall cfprefsd; killall Finder; sleep 4
  echo "after:"; defaults read com.apple.finder "NSToolbar Configuration Browser"
  echo "standard list view settings after:"; defaults read com.apple.finder FK_StandardViewSettings
} > "$OUT/toolbar.log" 2>&1

# Finder enforces a minimum width, so read the real window bounds back and capture
# around them (60pt of desktop on every side, for the shadow).
BOUNDS="$(osascript 2>"$OUT/finder.log" <<OSA
tell application "Finder"
  activate
  close every window
  set w to make new Finder window to (POSIX file "$FIXTURE" as alias)
  set current view of w to list view
  set bounds of w to {150, 150, 640, 510}
  set sidebar width of w to 160
end tell
-- Column widths: a longer Name, and Date Modified / Size narrow enough that Finder
-- switches to its short date format. Kind is hidden so name, date and size all fit.
tell application "Finder"
  tell list view options of w
    try
      set visible of column id kind column to false
    on error e
      log "hide kind: " & e
    end try
    try
      set width of column id name column to 270
      set width of column id modification date column to 104
      set width of column id size column to 70
    on error e
      log "widths: " & e
    end try
  end tell
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
tell application "Finder"
  set selection to {}
  return bounds of front Finder window
end tell
OSA
)"
echo "bounds: $BOUNDS" > "$OUT/bounds.txt"
IFS=', ' read -r L T R B <<< "$BOUNDS"
# Finder ignores column widths set through AppleScript or its preferences for a
# fresh window, so resize the columns the way a person would: drag the dividers
# (right to left, so earlier drags don't move later ones), then hide Kind from the
# header's context menu. Positions are measured from the reference: dividers at 203 / 384pt
# from the window's left edge, the column header 65pt below its top.
{
  command -v cliclick >/dev/null || brew install cliclick
  HY=$((T + 65)); D1=$((L + 203)); D2=$((L + 384)); D3=$((L + 480))
  # Kind: right-click the header where its label pokes in at the right edge; the menu
  # lists the columns, so K jumps to "Kind" and Return toggles it off.
  cliclick -w 400 rc:$((L + 485)),$HY w:600 t:k w:300 kp:return
  sleep 1
  drag() { cliclick -w 60 dd:"$1,$HY" dm:"$(( ($1 + $2) / 2 )),$HY" dm:"$2,$HY" du:"$2,$HY"; sleep 1; }
  drag $D2 $((D2 - 89))                    # Date Modified 181pt -> 92pt (short dates)
  drag $D1 $((D1 + 60))                    # Name 202pt -> 262pt (+30%)
} >"$OUT/columns.log" 2>&1
sleep 2
capture() { screencapture -x -R$((L - 96)),$((T - 96)),$((R - L + 192)),$((B - T + 192)) "$OUT/$1.png" >>"$OUT/screencapture.log" 2>&1 || true; }
sleep 4
capture "macos-$THEME$SUFFIX"

# the other Finder views: icons, columns, gallery
for v in "icon view:icons" "column view:columns" "flow view:gallery"; do
  osascript -e "tell application \"Finder\" to set current view of front Finder window to ${v%%:*}" -e 'delay 3' >>"$OUT/finder.log" 2>&1
  osascript -e 'tell application "Finder" to set selection to {}' >>"$OUT/finder.log" 2>&1
  sleep 2
  capture "macos-$THEME$SUFFIX-${v##*:}"
done
# Editors: TextEdit is the OS's text editor window. Capture it with prose ("text")
# and with source code ("code"; IgnoreHTML shows the markup instead of rendering it).
EDIT="$HOME/Documents/editors"; mkdir -p "$EDIT"
cp "$HERE/fixture-assets/text-sample.txt" "$EDIT/Essay.txt"
cp "$HERE/fixture-assets/code-sample.html" "$EDIT/index.html"
defaults write com.apple.TextEdit RichText 0
defaults write com.apple.TextEdit IgnoreHTML 1
osascript -e 'tell application "Finder" to close every window' >>"$OUT/finder.log" 2>&1
for e in "Essay.txt:text" "index.html:code"; do
  open -a TextEdit "$EDIT/${e%%:*}"; sleep 5
  BOUNDS="$(osascript -e 'tell application "TextEdit" to activate' \
    -e 'tell application "TextEdit" to set bounds of front window to {150, 150, 640, 510}' \
    -e 'delay 2' -e 'tell application "TextEdit" to return bounds of front window' 2>>"$OUT/editors.log")"
  echo "${e##*:} bounds: $BOUNDS" >> "$OUT/bounds.txt"
  IFS=', ' read -r L T R B <<< "$BOUNDS"
  sleep 2
  capture "macos-$THEME$SUFFIX-${e##*:}"
  osascript -e 'tell application "TextEdit" to close every window saving no' >>"$OUT/editors.log" 2>&1
  sleep 2
done
rm -f "$OUT/grey.png"; ls -la "$OUT" >> "$OUT/screencapture.log"
