# macOS (Finder) capture notes

Runner `macos-latest`: macOS 26.6.2 (Tahoe), a 1024x768 virtual display. Script:
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
- Size: bounds `{150, 150, 630, 510}` (480x360pt). Finder enforces a minimum width
  (about 484pt), so the real bounds are read back and the capture is taken around them
  (`bounds.txt` in the capture logs).
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
