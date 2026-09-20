# pane

Renders `<pre>` blocks in the documentation as pixel-accurate mock windows
(folder, text editor, code editor) that match the visitor's operating system:
macOS, Windows 11 or Linux (GNOME Files). Replaces `app/documentation/tools/finder`,
which stays untouched until every view has migrated.

## Goals

- Latest macOS, Windows 11 and GNOME look, in light and dark.
- Folder windows in tree and list views.
- One content node per window with a fixed set of decorative chrome nodes; the
  skin is chosen by CSS from `<html data-os="mac|win|linux">`, set by a tiny
  inline script in `<head>`. The default skin is a build option (`mac`) and is
  what visitors without JS see.
- Accessibility from day one. Mobile from day one.
- Inline SVG, never PNG.

## Authoring syntax

Compatible with today's markup: `pre.folder`, `pre.text`, `pre.code`,
`code.file`, `code.folder`. New attributes: `data-view="tree|list"`.

### OS-specific prose

Authors write `<span class="pane-name">Finder</span>`. The build expands it to
one child per OS, and the same CSS that skins the windows shows one of them
(no flash, no runtime text swapping, no-JS gets the default):

    <span class="pane-name"><span data-os="mac">Finder</span><span data-os="win">File Explorer</span><span data-os="linux">Files</span></span>

A small dictionary (`name`, `trash`, `modifier`, `rightclick`, ...) drives it.
An audit of `app/views` found very little OS-specific UI language (a handful of
Finder/Trash/Recycle Bin mentions), so the dictionary stays small.

### List view

Rows are the same indented lines as the tree. Optional columns follow a pipe:

    Fruits
      Apple.md | 2 KB | Mar 3, 2024
      Pear.txt

Missing columns are generated deterministically from a hash of the full path
(size scaled by extension, date within a fixed window relative to a constant,
not the build time), so output is stable between builds. "Kind" comes from the
extension and is named per OS. Columns: macOS Name / Date Modified / Size /
Kind; Windows Name / Date modified / Type / Size; GNOME Name / Size / Modified.

## Skins

- Text and code editor windows are skinned per OS too (title bar, window
  controls). Text editor: Notepad-like on Windows, GNOME Text Editor on Linux;
  code editor keeps one editor look with per-OS window buttons.
- The `<background>` desktop wallpaper also changes per OS, and with
  `prefers-color-scheme`, in CSS.
- Dark mode follows `prefers-color-scheme`; the docs site itself has no dark
  theme yet.
- Linux target: GNOME Files (Nautilus), stock libadwaita, not Yaru.
- Android maps to Windows and iOS/iPadOS to macOS (configurable table).
  ChromeOS maps to Linux.

Folder windows hide the sidebar (and other navigation chrome where the OS allows
it) so the folder structure and files are the focus; the reference captures do
the same. The skin can show the sidebar again later if we want a fuller window.

## Accessibility

- Content is a nested `ul`/`li` (a `table` for list view); no `role="tree"`.
- Window is a `figure` named by its title; all chrome, icons and dots are
  `aria-hidden`. Hidden per-OS chrome is `display: none`.
- Folder/file type and expanded state is visually hidden text.
- Line numbers and list columns are CSS-generated and `user-select: none` so
  copy/paste and screen readers get clean text.
- `prefers-reduced-motion` disables the blinking cursor; support
  `forced-colors`; scrollable regions are keyboard focusable; 4.5:1 contrast.

## Mobile

Windows scale down. On narrow screens, decorative chrome (sidebar, status bar,
toolbars) is dropped first, then columns in list view, before anything scrolls
horizontally.

## Icons and fonts

Monochrome UI glyphs use CSS `mask-image` with `currentColor`; coloured
file/folder icons are data-URI SVG backgrounds. `system-ui` fonts match the OS
being shown; bundle open-licensed Cantarell/Ubuntu Sans only if needed.

## Pixel accuracy

Reference screenshots per OS x light/dark x view, checked in under
`reference/`. A Puppeteer test renders a fixture page per skin and diffs with
`pixelmatch` at a per-region tolerance (text looser than chrome).

## Payload budget

Server-side code can be as large and slow as it needs; what ships to visitors
must be tiny. Guidelines:

- Build-time work does the heavy lifting (skin expansion, hashing, SVG
  optimisation, CSS minification, dead-code removal per page).
- One HTML content node per window (see above), no duplicated content, decorative
  chrome kept to the minimum nodes the three skins need.
- CSS: one shared stylesheet, minified, custom properties for shared values,
  SVGs optimised (svgo) and de-duplicated (shared `mask-image` glyphs). It is
  fine for it to be large in absolute terms; measure it gzip/brotli.
- JS: a single inline `<head>` snippet (target well under 500 bytes minified)
  that sets `data-os`. No runtime rendering, no text swapping.
- CI reports the CSS/JS/HTML sizes (raw and brotli) so regressions are visible;
  add a hard budget once we have a first version.

## QA: real vs. rendered comparison

Goal: for every OS x theme x view, compare a REAL screenshot (from CI runners,
or sourced from the web/supplied by hand) with the pane rendering of the same
fixture, captured in a browser in CI, and make the differences easy to inspect.
Not pixel-identical, but close enough to judge by eye and by metric.

- `reference/`: real screenshots (this PR's CI captures, plus web-sourced ones
  where a runner can't produce one, e.g. Retina macOS).
- `rendered/`: pane output for the same fixture, rendered by Puppeteer at the
  same window size and captured by a CI job, committed like the references.
- `qa/`: a small local server (`node app/helper/pane/qa`) that lists every
  OS/theme/view pair and shows real | rendered | diff side by side, with a swipe
  slider and overlay/blink modes, plus the pixel-difference score.
- Agents can use it too: a CLI (`node app/helper/pane/qa/diff.js`) writes diff
  PNGs and a JSON report of per-pair metrics, so a change can be checked without
  a human looking at every image.
- Both sides use one shared fixture definition (same tree, same window size and
  crop) so images align without manual work.

## Phase 1 (this PR): gather reference screenshots

`.github/workflows/pane-screenshots.yml` screenshots a real file manager on
GitHub-hosted runners (light and dark) and commits the results to `reference/`.
Scripts are in `screenshots/`. Findings from the first runs:

- **macOS: works.** `macos-latest` is macOS 26.6.2 (Tahoe); `screencapture` and
  Finder AppleScript both work. Light/dark toggles via System Events. 1024x768,
  1x (no Retina), so Retina detail needs web/supplied screenshots.
- **Linux: works.** `ubuntu-latest` is Ubuntu 24.04 (GNOME Files 46,
  libadwaita 1.5), so one release behind the newest GNOME. Needs `librsvg2-common`
  and `adwaita-icon-theme-full` for icons, and `ADW_DEBUG_COLOR_SCHEME` for real
  libadwaita dark mode. No compositor, so no window shadow or rounded outer
  corners. Check if a newer Ubuntu runner image appears.
- **Windows: works on `windows-latest`** (Windows Server 2025, build 26100), which
  has the Windows 11 style Explorer. The repo can't be checked out on Windows
  (a filename contains `|`), so the job downloads just the script.
  `windows-11-arm` is stuck on the Windows first-run setup screen and is dropped.
- **Sidebar/toolbar.** macOS: sidebar hidden (Option-Cmd-S) and the Finder toolbar
  trimmed to back/forward, view switcher and search by rewriting
  `NSToolbar Configuration Browser` before launch. Linux: `start-with-sidebar`
  gsetting. Windows: the navigation pane can't be hidden yet; UI Automation can
  open View > Show but the flyout isn't exposed, and zeroing the saved sizer
  width only shrinks it to a sliver.
- **Resolution (2x works on all three).**
  - Linux: `GDK_SCALE=2` under Xvfb.
  - Windows: Windows caps the display scale by *logical* resolution (roughly a
    600px minimum logical height), so 200% needs a 1600x1200 screen. The script
    switches the runner to 1600x1200 (`ChangeDisplaySettings`), then sets 200%
    through `DisplayConfigSetDeviceInfo` (the undocumented "set DPI scale" call).
    The navigation pane is hidden at 100% first because the setting sticks.
  - macOS: the runner display has no HiDPI modes, so `screenshots/hidpi.m` creates
    a HiDPI virtual display with the private `CGVirtualDisplay` API, makes it the
    main display, and `screencapture` then yields real Retina pixels.
- **Views.** One capture per view: Finder icons/list/columns/gallery, Explorer
  extra-large/large/medium/small icons, list, details, tiles, content, Nautilus
  list (tree) and icons. Explorer's flyout ignores mouse clicks on items, so views
  are picked with arrow keys after opening the flyout through UI Automation.
- **Fixture.** `make-fixture.sh` / `windows.ps1` create one `Fruits` folder and one
  file per type we need an icon for (Markdown, images, Google Docs, Word, bookmarks,
  HTML, Org, text) with created/modified dates spread over the years.
- **Window sizes.** All windows target 480px wide (logical), 96px of desktop around
  them. Finder enforces ~484px and Explorer ~386px minimums; Linux has a `-sidebar`
  variant at 890px. Heights differ per OS (Windows 2x is limited to a 600px-tall
  logical screen).
- **Backgrounds.** Captures sit on a checkerboard desktop of 20px white and mid-grey
  squares, so shadows can be measured. Linux has no compositor under Xvfb, so its
  rounded corners and shadow are synthesised with ImageMagick.
- **Layout of `reference/`.** `macos/ windows/ linux/` hold only screenshots;
  `resources/<os>/README.md` documents how each was captured, and CI puts logs in
  `resources/<os>/capture-logs/`. Only @2x is committed (see `reference/README.md`).

If a platform proves too limited, fall back to gathering screenshots from the
web (or supplied by hand) into `reference/`.

## Later

- Locale-aware dates/sizes (English formats only for now).
- Site-wide dark mode for the docs.
- Retire `tools/finder` after all views migrate.
