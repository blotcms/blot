# pane

Renders `<pre>` blocks in the documentation as pixel-accurate mock windows
(folder, text editor, code editor) that match the visitor's operating system:
macOS, Windows 11 or Linux (GNOME Files). Replaces `app/documentation/tools/finder`,
which stays untouched until every view has migrated.

## Goals

- Latest macOS, Windows 11 and GNOME look, in light and dark.
- Folder windows in list (a tree) and icons views.
- One content node per window with a fixed set of decorative chrome nodes; the
  skin is chosen by CSS from `<html data-os="mac|win|linux">`, set by a tiny
  inline script in `<head>`. The default skin is a build option (`mac`) and is
  what visitors without JS see.
- Accessibility from day one. Mobile from day one.
- Inline SVG, never PNG.

## API

    pane.folder(tree, opts) -> { html } | null   one folder window (markup only)
    pane.text(text, opts)   -> { html }          text editor window (macOS built; see DESIGN.md)
    pane.code(code, opts)   -> { html }          code editor window: highlighted, no wrapping (macOS built)
    pane.assets()           -> { css, js }       once per page: static and cacheable
    pane.transform($)                            cheerio hook for the docs build

- **Markup and assets are separate**: a page with 20 windows ships one stylesheet and
  one head snippet, not 20 copies.
- **`null` means "not implemented"**, never an exception for author input, so callers
  can fall back.
- **Folders**: a row is a folder when it ends in `/`, has children, or has no `.` in its
  name (the docs' existing convention, so an empty "Posts" works).
- **Views**: authors can ask for `list` (default) and `icons`, the two views every OS has.
  The other captured views (columns, gallery, tiles, content, sidebar) are OS-specific
  studies for comparing skins, not authorable.
- **Deterministic**: output never depends on the real clock (`now` is an option with a
  constant default), so builds are stable and cacheable.
- **Overrides**: `os` and `theme` pin one window (the copy around it may say "Finder");
  the CSS applies each per-OS rule to windows following the visitor's OS
  (`html[data-os]`) and to windows pinned to that OS (`data-pin`), never both. An OS
  without a built skin is not honoured: a pin for it is ignored and a visitor on it gets the
  default skin. `width`
  and `height` are CSS variables (`--pane-w`, `--pane-h`).
- **Chrome is CSS**: window chrome should be drawn with pseudo-elements and SVG
  backgrounds on a few wrapper elements, not many decorative DOM nodes, so 20 windows
  don't multiply the HTML.

## Authoring syntax

Compatible with today's markup: `pre.folder`, `pre.text`, `pre.code`,
`code.file`, `code.folder`. New attribute: `data-view="list|icons"` (`tree` is accepted as `list`).

### OS-specific prose

Authors write `<span class="pane-name">Finder</span>`. The build expands it to
one child per OS, and the same CSS that skins the windows shows one of them
(no flash, no runtime text swapping, no-JS gets the default):

    <span class="pane-name"><span data-os="mac">Finder</span><span data-os="win">File Explorer</span><span data-os="linux">Files</span></span>

A small dictionary (`name`, `trash`, `modifier`, `rightclick`, ...) drives it.
An audit of `app/views` found very little OS-specific UI language, so the dictionary stays small.
**Nothing in the docs is converted today (audited again when the docs build was wired):** the only
Finder / Trash / Recycle Bin mentions are in `how/not-synced.html`, a table of system files Blot
ignores (".DS_Store: Finder metadata file", "Recycle bin folder", ".trash"). Those describe a specific
OS's files whichever OS the visitor uses, so making them follow the visitor would be wrong (a
Windows visitor would read "File Explorer metadata file" for `.DS_Store`). The other OS mentions are
platform lists and tool pages ("on Mac, you can open the folder directly"), also specific, and
`app/clients/icloud/views/setup.html` ("Right-click the new folder") is Mac-only setup text. Use
`pane-name` in new prose that talks about the visitor's own file manager (e.g. "open the folder in
<span class="pane-name">Finder</span>"); the build expands it and warns on an unknown term.

### List view

Rows are the same indented lines as the tree. Optional columns follow a pipe:

    Fruits
      Apple.md | 2 KB | Mar 3, 2024
      Pear.txt

Missing columns are generated deterministically from a hash of the full path
(size scaled by extension, date within a fixed window relative to a constant,
not the build time), so output is stable between builds. "Kind" comes from the
extension and is named per OS. Columns: macOS Name / Date Modified / Size (Kind is
hidden, as in the references); Windows Name / Date modified / Type / Size; GNOME Name /
Size / Modified.

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

- Content is a nested `ul`/`li` in every view (see DESIGN.md); no `role="tree"`.
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

Goal: for every OS x theme x view, compare a REAL screenshot (captured on CI
runners) with the pane rendering of the same fixture, captured in a browser in
CI, and make the differences easy to inspect. Not pixel-identical, but close
enough to judge by eye and by metric. Built; see `qa/README.md`.

- `reference/`: real screenshots captured by CI (see Phase 1).
- `rendered/`: pane output for the same case, rendered by Puppeteer at the same
  scale on the runner of the matching OS (so the system fonts line up) by
  `.github/workflows/pane-qa.yml`, committed like the references so the viewer
  works without Chrome.
- `qa/`: the case registry (derived by scanning `reference/`), an adapter
  interface (`render(caseId) -> { html, css }`, with hand-written `qa/fixtures/`
  until the module exists), the renderer, a pure comparison engine (pixelmatch
  diff, window detection, shadow profile, diff clusters, text row positions) and
  two front ends:
  - `node app/helper/pane/qa/diff.js [--case ID] [--explain] [--json]` for
    agents: diff images and a JSON report in `qa/out/`, a table, coordinates of
    the largest differences in CSS px, non-zero exit above `qa/thresholds.json`.
  - `node app/helper/pane/qa`: a local viewer (side by side, swipe, onion skin,
    blink, live HTML, synced zoom to 400%, pixel readout, shadow charts, mask and
    cluster overlays, live reload, re-render).
- Chrome is compared strictly, text loosely (row positions, not glyph pixels);
  time-dependent text (the date columns) is masked; the fixtures freeze dates.
- Decisions to revisit: thresholds start loose; `rendered/` is committed (it
  makes the viewer and diff work without Chrome, at the cost of binary churn);
  the Windows and Linux captures have no shadow, so their shadow metric only
  checks the rendering does not add one.

## Phase 1 (this PR): gather reference screenshots

`.github/workflows/pane-screenshots.yml` screenshots a real file manager on
GitHub-hosted runners (light and dark) and commits the results to `reference/`.
Scripts are in `screenshots/`. Findings from the first runs:

- **macOS: works.** `macos-latest` is macOS 26.6.2 (Tahoe); `screencapture` and
  Finder AppleScript both work. Light/dark toggles via System Events. 1024x768,
  1x by default; Retina comes from a HiDPI virtual display (see below).
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
- **Window sizes.** All windows target 490px wide (logical), 96px of desktop around
  them. Finder enforces ~484px and Explorer ~386px minimums; Linux has a `-sidebar`
  variant at 890px. Heights differ per OS (Windows 2x is limited to a 600px-tall
  logical screen).
- **Backgrounds.** Captures sit on a plain 50% grey desktop so shadows are easy to see;
  the sample images and HTML page are white/mid-grey checkerboards. Linux has no compositor under Xvfb, so it has no
  window shadow (its rounded corners are drawn with ImageMagick).
- **Layout of `reference/`.** `macos/ windows/ linux/` hold only screenshots;
  `resources/<os>/README.md` documents how each was captured, and CI puts logs in
  `resources/<os>/capture-logs/`. Only @2x is committed (see `reference/README.md`).

## Fresh dates (built; formats to verify)

The docs are rendered once per deploy (`RUN node app/documentation/build` in the Dockerfile,
`build/html.js` runs the transformers), so the windows can show dates relative to the build
time without any runtime work: every visitor sees the same static HTML until the next deploy.

- **`now` is the build timestamp.** The docs build passes one `now` per build process (captured
  once at start, never per page or per call, so all pages agree) through
  `pane.transform($, { now })` down to `folder()`. Times are formatted in UTC. The
  QA harness and the screenshot tooling keep the constant default, so their output stays
  deterministic. Tests pass an explicit `now`.
- **Staleness is accepted:** dates are "as of the last deploy". No build argument to force a rebuild.
- **Recency-weighted invented dates**, replacing the uniform 1 to 900 days back: rank the rows
  by hash (stable for a given folder), then give the first rank "hours ago today", the next
  "yesterday", a few more "this week", some "this month", and the rest up to about 18 months back.
  Never later than `now`. Ranking (not a per-file hash) guarantees even a two-file folder shows
  something recent.
- **Relative dates in the source** as the date column: `Apple.md | 2 KB | 3d`, meaning three
  days before `now`. Units `m`, `h`, `d`, `w`, `mo`, `y`, plus `today` and `yesterday`.
  Absolute dates stay verbatim (`Mar 3, 2024`).
- **Built:** `lib/format.js` (`isoNow`, `resolveAge`, `inventDates`; `formatDate` knows today,
  and yesterday), `lib/markup.js`, `pane.transform($, { now })`, `tests/dates.js`.
- **Fixture:** `make-fixture.sh` and `windows.ps1` now date files today, yesterday, 5 days back, then
  further, so the references show each OS's forms. **Verified against the recapture:** Finder shows
  "Yesterday", then `9/16/26`; GNOME shows `Yesterday 11:35`, then `16 Sep 2026` (no weekday names).
  GNOME also widens the Modified column by 22px (Name narrower, Size shifted left) when a row says
  Yesterday: `folder()` adds the class `pane-yd` and `linux.css` applies the measured widths. The date
  columns are still masked in QA, so the masks (`qa/lib/cases.js`) must cover the widest new text.

## Status

Built and passing: reference screenshots for all three OSes (folder views, text and code editor windows,
desktop icons), pinned runner OS versions with a CI guard, the QA harness (pixel diff, backdrop matte
check, accessibility and mobile audit), the folder list view, icons view and desktop view for macOS in
light and dark, the folder list view for Windows 11 and GNOME Files in light and dark, editor windows
(macOS skin; Windows and Linux get the macOS look), fresh build-time dates, and the docs build rendering
`pre.folder`, `pre.text` and `pre.code` with pane (`data-view="desktop"` on `pre.folder` for loose icons,
no window).
Not built: Windows/Linux skins for the icons view, desktop view and editor windows (visitors on those
OSes see the macOS look, by design); retiring `tools/finder`. Open decisions: whether docs code blocks should be coloured (GNOME highlights;
TextEdit/Notepad are plain), whether to keep `pane-name` (nothing in the docs uses it yet). Later items: the
viewer backdrop switcher, two-backdrop real captures for translucency, per-OS stylesheets, and the
first real OS update (Ubuntu 26.04 is available; follow `screenshots/UPDATING-OS.md`).

## Docs integration (built)

`app/documentation/build/html.js` runs `pane.transform($, { now })` (one `now` per build process) and then
the old finder for what pane doesn't render yet (inline `code.file`/`code.folder`), so
the folder and editor windows (`pre.folder`, `pre.text`, `pre.code`) are pane's and everything else is unchanged. `build/css.js` appends
`pane.assets().css` to `documentation.min.css`; `views/partials/head.html` carries the head script
(a test keeps it identical to `pane.assets().js`). The dev cache hash includes pane's sources.
`<background>` wrappers around windows still come from the old finder CSS (wallpapers are deferred).
Tested in `app/documentation/tests/pane.js`. Checked against the real docs stylesheet and real pages
(all three skins, light): no leakage from the docs' global CSS. To retire the finder, build `text`, `code`
and the icons view, then drop `finder.html_parser` from `windows()` and the finder CSS from the bundle.

## Wallpapers (not built)

Detail crops of paintings, gradients, etc. as desktop backgrounds behind the windows, for the
docs and brochure. Nothing is built into the module; the constraint is that windows stay
backdrop independent (DESIGN.md §10), guarded by `qa/backdrop.js`.

- **First:** the QA viewer gets a backdrop switcher (grey, white, black, and images from a local
  folder; one public-domain painting crop from Wikimedia as the example, kept out of the repo
  unless small), rendering the same live HTML over each. Do this after the Windows and Linux
  skins have settled, since the viewer is the most-edited part of the harness.
- **Translucent materials in CSS:** possible with `backdrop-filter` + a semi-transparent tint
  (Mica, macOS materials), after the `.pane` opaque-fill refactor in DESIGN.md §10. Per skin,
  choose which surfaces are translucent, and list them in `qa/backdrop.json`.
- **Planned: two-backdrop reference captures.** The matte trick works on real screenshots too:
  capture each OS's default view on a black and on a white desktop; per pixel,
  `alpha = 1 - (white - black)/255`, so we measure the real alpha of Finder's toolbar, Mica, the
  real shadow's alpha profile, and the real corner radius. That replaces guessing a tint from one
  grey capture (which can only bound the alpha from below). Plan:
  1. `macos.sh`: the borderless desktop-level window's colour is a parameter (today 0.5 grey);
     `windows.ps1`: `SetSysColors` COLOR_BACKGROUND (as now) to black/white, no wallpaper;
     `linux.sh`: `xsetroot -solid` (Linux has no shadow or translucency, so it may be skipped).
  2. Each job takes two extra shots of the default view (`-onblack`, `-onwhite`) per theme; keep
     everything else identical (window position, focus state, selection).
  3. QA: a matte reference per case from those two images, compared with the rendering's matte
     from `lib/matte.js` (alpha per region, shadow profile). New metric, not a pixel diff.
  4. Fit the tint alpha and blur of the translucent layers from the measured alpha.
  Open questions: whether Windows Mica follows a solid desktop colour (it samples the wallpaper;
  a solid background may reduce it to a flat tint, which is what we would measure); whether
  the macOS material blurs our desktop-level grey window; capture time is +2 shots per job (small).
  Name the new captures with the existing suffix convention (`-onblack`), which makes them
  cases automatically, so the adapter must return null or a fixture for them.
- **Desktop icon labels.** The icon-grid rendering is built (`view:"desktop"`, macOS, DESIGN.md
  "Desktop view"): a flat drop-shadow + text-shadow stand in for legibility on any background today.
  The `-desktop` captures are text on plain grey; matching them for real (alpha text shadow measured
  off a wallpaper, not guessed) is still open, and depends on this section's wallpaper work landing.

## Later

- Locale-aware dates/sizes (English formats only for now).
- Site-wide dark mode for the docs.
- Retire `tools/finder` after all views migrate.
- Optional Word-installed Windows variant: the Word icon and hidden `.doc`/`.docx` extensions,
  if we ever want that look (the reference has no Word, so it shows "DOC File" today).
