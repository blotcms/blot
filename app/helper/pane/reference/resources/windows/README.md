# Windows (File Explorer) capture notes

Runner `windows-latest`: Windows Server 2025 (build 26100), which has the Windows 11
style Explorer (tabs, command bar, Mica title bar). A "Test Mode / Windows Server 2025"
watermark sits at the bottom right of the screen; the capture is cropped to avoid it.
`windows-11-arm` was tried and is stuck on the first-run setup screen. Script:
`screenshots/windows.ps1`.

## Checkout
The repo has a filename containing `|`, which Windows can't check out (even with
sparse-checkout), so the job downloads just `windows.ps1` and `fixture-assets/` from
raw.githubusercontent.com at the commit SHA.

## Dark mode
`HKCU\...\Themes\Personalize` `AppsUseLightTheme` / `SystemUsesLightTheme`.

## Retina (200%)
Windows limits the display scale by the *logical* resolution (roughly a 600px minimum
logical height): 1024x768 allows 125%, 1920x1080 allows 175%, 1600x1200 allows 200%.
So: `ChangeDisplaySettings` to 1600x1200, then set 200% with
`DisplayConfigSetDeviceInfo` (type -4, the undocumented "set DPI scale" call; the value
is a step relative to the recommended one, read with type -3). Explorer then reports
192 DPI. The script must be per-monitor DPI aware to capture real pixels. Also tried and
not needed: `SystemParametersInfo(SPI_SETLOGICALDPIOVERRIDE)` (reaches 125% only),
the `LogPixels` registry values (ignored), a loopback RDP session with
`desktopscalefactor` (couldn't create the user).

## Explorer window
- Navigation pane: hide it at 100% *before* scaling (the setting persists). UI
  Automation can invoke the View button but can't see the flyout (a XAML popup outside
  the UIA tree), so the Show and Navigation pane items are clicked at fixed offsets.
- Command bar: there is no setting to hide it.
- View options: opening the flyout through UI Automation puts keyboard focus on the
  first item; arrow keys plus Enter pick a view. Mouse clicks on the flyout items are
  ignored. Flyout order: extra large, large, medium, small, list, details, (pane
  toggles), tiles, content. Only medium (`-icons`), list, tiles and content are kept.
- Size: 490x360 logical px, but `MoveWindow` includes 7px invisible resize borders (left,
  right, bottom), so ask for +14 wide and +7 tall. Explorer's minimum width is about
  386px.
- Extensions are hidden by default ("About", not "About.txt").
- Before each capture: click the tab (moves focus off the toolbar) and park the mouse
  at the screen corner (no tooltip or hover). `CopyFromScreen` excludes the cursor.
- The runner leaves "System Properties" / "Performance Options" dialogs open; the
  `SystemProperties*` processes are killed.

## Desktop
No wallpaper and a 50% grey desktop colour (`HKCU\Control Panel\Colors\Background`
plus `SetSysColors`). Desktop icons are hidden with `HKCU\...\Explorer\Advanced
HideIcons=1` and an Explorer restart; at 200% the runner's icons wrapped into a second
column and crept into the capture. (The Progman "toggle icons" message is stateful and
unreliable.)

## Captures
`DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS)` gives the visible frame; the
capture is that plus 80 logical px each side (less than the other OSes' 96: the screen is
short and the watermark sits at the bottom right). At 2x the screen is only 800x600
logical, which is why the window is 360px tall. The shadow is Windows' own (faint).
