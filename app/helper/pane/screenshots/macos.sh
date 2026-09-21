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
EDIT="/private/tmp/pane-editors"; mkdir -p "$EDIT"  # not ~/Documents: TextEdit would block on a permission prompt there
cp "$HERE/fixture-assets/text-sample.txt" "$EDIT/Essay.txt"
# TextEdit renders .html as rich text whatever the preferences say, so the code
# sample is a .txt here (the window chrome is what matters)
cp "$HERE/fixture-assets/code-sample.html" "$EDIT/Snippet.txt"
defaults write com.apple.TextEdit RichText -bool false
defaults write com.apple.TextEdit IgnoreHTML -bool true
defaults write com.apple.TextEdit ShowRuler -bool false
defaults write com.apple.TextEdit CheckSpellingWhileTyping -bool false
defaults write -g NSAutomaticSpellingCorrectionEnabled -bool false
osascript -e 'tell application "Finder" to close every window' >>"$OUT/finder.log" 2>&1
for e in "Essay.txt:text" "Snippet.txt:code"; do
  open -a TextEdit "$EDIT/${e%%:*}"; sleep 6
  screencapture -x "$OUT/debug-textedit-${e##*:}.png"
  # System Events (not TextEdit itself, which is what timed out) places and reads the window
  osascript >>"$OUT/editors.log" 2>&1 <<OSA
tell application "System Events" to tell process "TextEdit"
  set frontmost to true
  set position of window 1 to {150, 150}
  set size of window 1 to {490, 360}
end tell
OSA
  sleep 2
  BOUNDS="$(osascript -e 'tell application "System Events" to tell process "TextEdit" to return (position of window 1) & (size of window 1)' 2>>"$OUT/editors.log")"
  # position + size -> left, top, right, bottom
  IFS=', ' read -r PX PY SX SY <<< "$BOUNDS"
  BOUNDS="$PX, $PY, $((PX + SX)), $((PY + SY))"
  echo "${e##*:} bounds: $BOUNDS" >> "$OUT/bounds.txt"
  IFS=', ' read -r L T R B <<< "$BOUNDS"
  sleep 2
  capture "macos-$THEME$SUFFIX-${e##*:}"
  osascript -e 'tell application "TextEdit" to close every window saving no' >>"$OUT/editors.log" 2>&1
  sleep 2
done
# Browser: Safari, a small window on a local page opened as a file (a local HTTP server made macOS
# ask "Allow Python to find devices on local networks?", and the dialog ended up in the capture).
# Placed and read back through System Events, like the editors. Best-effort: debug screenshots
# and logs show what the runner allowed.
WEB="/tmp"  # short path: it shows in the address bar
cp "$HERE/fixture-assets/browser-sample.html" "$WEB/blot.html"
osascript -e 'tell application "Finder" to close every window' >>"$OUT/browser.log" 2>&1
open -a Safari "$WEB/blot.html"; sleep 8
screencapture -x "$OUT/debug-safari.png"
osascript >>"$OUT/browser.log" 2>&1 <<OSA
tell application "System Events" to tell process "Safari"
  set frontmost to true
  set position of window 1 to {150, 150}
  set size of window 1 to {600, 400}
end tell
OSA
sleep 2
BOUNDS="$(osascript -e 'tell application "System Events" to tell process "Safari" to return (position of window 1) & (size of window 1)' 2>>"$OUT/browser.log")"
IFS=', ' read -r PX PY SX SY <<< "$BOUNDS"
BOUNDS="$PX, $PY, $((PX + SX)), $((PY + SY))"
echo "browser bounds: $BOUNDS" >> "$OUT/bounds.txt"
IFS=', ' read -r L T R B <<< "$BOUNDS"
sleep 2
capture "macos-$THEME$SUFFIX-browser"
osascript -e 'tell application "Safari" to quit' >>"$OUT/browser.log" 2>&1
sleep 2
# Desktop icons: the "Your site" contents (files and the Fruits folder) as icons on the
# desktop itself. The grey window sits at the desktop level, below Finder's icons. The
# Dock is hidden and the capture starts under the menu bar.
osascript -e 'tell application "TextEdit" to quit' >>"$OUT/finder.log" 2>&1
defaults write com.apple.dock autohide -bool true; killall Dock; sleep 3
# Old report.doc looks like Report.docx, so leave it off: 12 icons fill two columns of six
cp -Rp "$FIXTURE/." "$HOME/Desktop/"; rm -f "$HOME/Desktop/Old report.doc"
osascript -e 'tell application "Finder" to close every window' -e 'tell application "Finder" to activate' >>"$OUT/finder.log" 2>&1
sleep 6
osascript -e 'tell application "Finder" to select {}' >>"$OUT/finder.log" 2>&1
sleep 3
screencapture -x -R0,0,1024,768 "$OUT/debug-desktop-full.png" >>"$OUT/screencapture.log" 2>&1 || true
# Finder lays the icons out by name in columns from the right edge (positions set through
# AppleScript are ignored); capture just those two columns
screencapture -x -R760,30,264,660 "$OUT/macos-$THEME$SUFFIX-desktop.png" >>"$OUT/screencapture.log" 2>&1 || true
rm -f "$OUT/grey.png"; ls -la "$OUT" >> "$OUT/screencapture.log"
