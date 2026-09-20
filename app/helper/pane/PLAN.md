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

## Phase 1 (this PR): gather reference screenshots

`.github/workflows/pane-screenshots.yml` tries to screenshot a real file manager
on GitHub-hosted runners (Ubuntu + GNOME Files, macOS + Finder, Windows +
Explorer, light and dark) and uploads them as artifacts. Scripts live in
`screenshots/`. Unverified assumptions, to be settled by the run:

- macOS: TCC may block `screencapture` and Finder automation.
- Windows: hosted runners are Windows Server; Explorer may not look like
  Windows 11. `windows-11-arm` is included as a second attempt.
- Display sizes are small and 1x.

If a platform fails, fall back to gathering and organising screenshots from the
web (or supplied by hand) into `reference/`.

## Later

- Locale-aware dates/sizes (English formats only for now).
- Site-wide dark mode for the docs.
- Retire `tools/finder` after all views migrate.
