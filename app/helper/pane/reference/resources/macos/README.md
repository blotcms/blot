# macOS (Finder) capture notes

Runner `macos-26` (pinned; see `screenshots/UPDATING-OS.md`): macOS 26.6 (Tahoe), a 1024x768 virtual display. Script:
`screenshots/macos.sh`, helper `screenshots/hidpi.m`.

## Retina (2x)
The runner's display exposes no HiDPI modes (`displayplacer list` shows scaling off in
every mode, and `CGDisplayCopyAllDisplayModes` with
`kCGDisplayShowDuplicateLowResolutionModes` finds none). What works: `hidpi.m` creates a
HiDPI virtual display with the private `CGVirtualDisplay` API (looked up by class name
at runtime), makes it the main display (`CGConfigureDisplayOrigin` at 0,0) and keeps it
alive for the run. Finder then opens on it and `screencapture -R` returns real 2x pixels
(a 1024x768-point display captures as 2048x1536). Being a private API it could change
in a future macOS.

## Desktop
Finder refuses to set the wallpaper over AppleScript (error -10000). Instead a JXA
script paints a borderless window at `kCGDesktopWindowLevel` filled with 50% grey.

## Finder window
- Appearance: System Events `appearance preferences` dark mode on/off.
- Size: bounds `{150, 150, 640, 510}` (490x360pt). Finder enforces a minimum width
  (about 484pt), so the real bounds are read back and the capture is taken around them
  (`bounds.txt` in the capture logs).
- List view columns: Finder ignores widths set through AppleScript (`list view options`,
  no error, no effect) or its preferences (`FK_StandardViewSettings`, read back correctly,
  ignored) for a fresh window. What works is dragging the column dividers with
  `cliclick` (right to left, so earlier drags don't move later ones): Date Modified
  is narrowed until Finder switches to its short date format, Name is widened by 30%,
  and Kind is hidden from the header's context menu (right-click, K, Return). Cmd-J
  View Options followed by Cmd-W closed the Finder window instead, so avoid it. Divider positions are measured from
  the screenshot and relative to the window bounds.
- Sidebar hidden with Option-Cmd-S (View menu) via System Events.
- Toolbar reduced to back/forward: rewrite `NSToolbar Configuration Browser` in
  `com.apple.finder.plist` (`TB Item Identifiers` = `com.apple.finder.BACK`), then
  `killall cfprefsd Finder`. Other identifiers: `SWCH` (view switcher), `SRCH`
  (search), `ARNG`, `SHAR`, `LABL`, `ACTN`.
- Tree expanded with Cmd-A then Option-Right in list view; selection cleared with
  `set selection to {}`.
- Scroll bars forced to `WhenScrolling` so no scroller is drawn.
- Views: `set current view of front Finder window to icon view / list view /
  column view / flow view` (gallery is `flow view`).
- File dates: `touch -t` on macOS also moves the creation date back when the given
  time is earlier, so both dates vary.

## Captures
`screencapture -x -R` in points, 96pt around the window. The window shadow is Finder's
own. The gallery view looks sparse with dummy files (empty preview pane).

## Editor windows (`-text`, `-code`)
TextEdit, in plain-text mode (`RichText` false, spelling checks and ruler off). Files live in
`/private/tmp/pane-editors`, not `~/Documents`: TextEdit blocks on a permission prompt
there and every AppleEvent to it times out (-1712). The window is placed and read back
through System Events. TextEdit renders `.html` files as rich text whatever
`IgnoreHTML` says, so the code sample is `Snippet.txt`.

## Browser window (`-browser`)
Safari, sized 600x400pt (deliberately small; a browser window is mostly chrome). It opens
`fixture-assets/browser-sample.html` copied to `/tmp/blot.html` (a short path, because Safari shows it in the address bar), as a
file. A local `python3 -m http.server` worked too, but made macOS ask "Allow Python to find
devices on local networks?", and the dialog landed in the capture. Safari's compact layout
(Tahoe) shows the sidebar and tab buttons, back/forward, the address pill and no tab bar.
Placed and read back through System Events like the editors; `debug-safari.png` and
`browser.log` in the capture logs show what the runner did.

## Desktop icons (`-desktop`)
The "Your site" contents (all files and `Fruits`, except `Old report.doc`, which looks like
`Report.docx`) copied to `~/Desktop` and captured straight off the desktop, on the grey
desktop-level window (Finder's icons sit above it). The Dock is hidden
(`defaults write com.apple.dock autohide`). Finder lays the icons out by name in columns from
the right edge; positions set through AppleScript (`set position of item ... of desktop`) and
`arrangement ... not arranged` are accepted but ignored, so the capture is just those two
columns (`screencapture -R760,30,264,660`).
