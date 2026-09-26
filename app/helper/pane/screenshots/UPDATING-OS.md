# Updating an OS to a newer version

A guide for an agent (or person) asked to move pane to a newer macOS, Windows or
Ubuntu/GNOME. Read `../AGENTS.md` first, then `README.md` in this directory; this file is
the procedure, those are the background.

## Why this exists
pane's whole premise is fidelity to **real screenshots taken on GitHub-hosted runners**.
When an OS gets a new look, three things must move together, in this order:

1. the **reference screenshots** (`../reference/<os>/`), recaptured on the new OS;
2. the **skin** (`../css/<os>.css`, `../icons/<os>/`, thresholds, masks) so the rendering
   matches the new references;
3. the **pin** (`os-versions.json` and the `runs-on` labels), moved last, only once 1 and
   2 are done and reviewed.

Moving the pin first, or alone, would either fail every run or, worse, commit references
nobody looked at.

## What is pinned, and how it fails
| where | what |
|---|---|
| `os-versions.json` | the versions the references were captured on (only what can change the UI: macOS major.minor, Windows build number, Ubuntu release + Nautilus major + libadwaita major.minor) and the pinned runner label for each OS |
| `.github/workflows/pane-screenshots.yml` | `runs-on: macos-26`, `windows-2025`, `ubuntu-24.04` (never `-latest`) |
| `.github/workflows/pane-qa.yml` | the same three labels for the `render` matrix (rendering must happen on the OS the reference came from, or fonts differ) |
| `check-os.js` | first real step of every capture job: compares the runner with `os-versions.json`, fails with an annotation and a step summary pointing at this file. The pane-qa render job runs it with `--basic` (release/build only). The failed job commits nothing, so the old references stay. |
| `check-runner-images.js` + `pane-os-watch.yml` | weekly (default branch only): opens an issue "pane: update the <os> reference screenshots to <label>" when GitHub offers a newer runner image than the pinned one. |
| `tests/os-check.js` | unit tests for both scripts |

The guard fires in two different situations. Work out which one you are in first:

- **A. The image moved under a label we pin.** Runner images are rebuilt often; `macos-26`
  is 26.6 today and will be 26.7 later. The guard fails with e.g. "macOS 26.6 expected,
  26.7 on this runner". This is the common case and is usually a small visual change (or
  none at all). Procedure: recapture, review, retune if needed, bump the version in
  `os-versions.json`. Labels stay.
- **B. A new OS generation appeared under a new label** (`macos-27`, `ubuntu-26.04`,
  `windows-2027`), reported by the weekly issue, or requested by a person. Nothing fails
  yet: the old label keeps working until GitHub retires it (they announce this in
  `actions/runner-images` issues and deprecation notices; a retired label makes jobs fail
  to start). Procedure: same, but you also change the labels. Larger visual change likely.

## Facts about the runners (as of 2026-09-21; verify, they drift)
Source of truth: the table in
<https://github.com/actions/runner-images> (`README.md`), which maps labels to images;
per-image release notes are its GitHub releases; the "Set up job → Runner Image" group in
any job log shows the exact image version used.

- **macOS:** `macos-26` = macOS 26.x Tahoe on Apple Silicon (arm64); `macos-latest` points
  at it. macOS 15 is also offered. Fonts: SF (system).
- **Windows:** `windows-2025` = Windows Server 2025, build 26100, the 24H2 code base, the
  newest x64 Windows image. There is no Windows 11 client x64 runner; `windows-11-arm`
  exists but is stuck on the first-run setup screen. A "Test Mode / Windows Server 2025"
  watermark sits at the bottom right of the screen. So a Windows update is usually a new
  Server build, not a new Windows generation; expect small Explorer changes.
- **Linux:** `ubuntu-24.04` = Ubuntu 24.04, GNOME Files (Nautilus) 46.4, libadwaita 1.5.
  `ubuntu-26.04` is **already available** (GNOME is newer, and Nautilus/libadwaita
  differ visibly); `ubuntu-latest` still points at 24.04. It is the first real update to
  do. There is no compositor under Xvfb, so no shadow or rounded window corners in the
  capture (the script rounds corners; no shadow is deliberate).

## Procedure

### 0. Set up
- Work on a branch named for the update (`pane-os-<os>-<version>`), pushed to origin. Do
  not touch the other two OSes. The other agents' work on this module continues in
  parallel: rebase often.
- Do the reading: `../AGENTS.md`, `README.md` here, `../reference/resources/<os>/README.md`
  (the per-OS capture notes: this is what the capture script does and why), `../DESIGN.md`,
  `../qa/README.md`.
- Keep the **current** references for comparison: they are in git history
  (`git show <sha>:app/helper/pane/reference/<os>/<file>.png > /tmp/old-<file>.png`) and
  the first image you look at should be the old one next to the new one.

### 1. Find out what changed
- Case A: read the runner-images release notes for the image version in the failing
  log (`gh release list -R actions/runner-images`), for OS or app changes. Look at
  `capture-logs/<os>-<theme>-2x/versions.txt` in the last good capture for the exact
  old versions.
- Case B: read the new OS's release notes for file manager changes (Finder, Explorer,
  Nautilus). Search for known UI changes: toolbar, title bar, corner radii, icon
  redesigns, date and size formats, default view settings, sidebar behaviour.
- Write down what you expect to differ before you capture. It makes surprises visible.

### 2. Point the capture at the new OS (temporarily)
Change what you have to for the run to happen, on your branch:
- Case A: nothing yet. Set the new expected values in `os-versions.json`
  (`version`/`build`/`nautilus`/`libadwaita`), because the run must pass the guard to
  capture. That edit is provisional until step 6: **do not merge until the recaptured
  references and the skin are reviewed**.
- Case B: change the label in **both** `pane-screenshots.yml` (the `runs-on` of that OS,
  and the Windows matrix `runner`) and `pane-qa.yml` (the `render` matrix), and the
  `runner` and version fields in `os-versions.json`. Keep the three files consistent; a
  mismatch between the label and the recorded versions is caught by the guard on the
  first run.
- Pushing a workflow change makes the `plan` job capture all three OSes. To spend
  minutes on one OS, dispatch instead of relying on the push:
  `gh workflow run pane-screenshots.yml --ref <branch> -f os=<macos|windows|linux>` (and
  expect the other two to run once from the push; cancel them if you like).

### 3. Capture, and fix the scripts
Run it and watch (`gh run watch`); a full OS takes about 10 minutes. The capture scripts
are fragile by nature (they drive real GUIs); a new OS version breaking a step is normal.
Always read `reference/resources/<os>/capture-logs/` after a run, and add logging before
guessing. Where they are likely to break:

- **macOS** (`macos.sh`, `hidpi.m`): the Finder toolbar and window are configured by
  rewriting Finder's preferences (the `NSToolbar Configuration Browser` key) and by
  System Events / AppleScript (needs the runner's automation permissions; a new macOS can
  change or add permission prompts and can time out AppleEvents, `-1712`). Clicks
  and drags use `cliclick` at coordinates that move if the Finder window or toolbar layout
  changes. The Retina virtual display uses the private `CGVirtualDisplay` API in
  `hidpi.m`, which a major macOS release may change or remove. Window sizes: Finder
  enforces a minimum (about 484px wide today). Keep dates in the past and the fixture's 13
  items.
- **Windows** (`windows.ps1`): Explorer is driven by UI Automation (element names and
  the View menu flyout are localized/versioned and change), window and DPI handling
  (`ChangeDisplaySettings` to 1600x1200 then `DisplayConfigSetDeviceInfo` for 200%, which
  Windows caps by logical resolution), Notepad from the Microsoft Store via winget (the
  editor captures), desktop icons (`HideIcons` reverts on Explorer restart, so the script
  empties the desktop instead), and the crop that avoids the Server watermark.
  Explorer's minimum window width is about 386px.
- **Linux** (`linux.sh`, the `apt-get install` list in the workflow): package names and
  versions change between Ubuntu releases; check that `nautilus`, `gnome-text-editor`,
  `libadwaita-1-0`, `adwaita-icon-theme(-full)`, `fonts-cantarell` and the Desktop Icons
  NG package (`gnome-shell-extension-desktop-icons-ng`, used for the `-desktop` capture)
  still exist and behave: DING and its gjs script are the likeliest to be gone or
  changed. Real libadwaita dark mode needs `ADW_DEBUG_COLOR_SCHEME=prefer-dark`
  (confirm it still works). Nautilus settings keys (`org.gnome.nautilus.list-view
  use-tree-view`, `default-folder-viewer`) and the way the sidebar collapses below about 500px
  can change; the tree-view expansion is done by clicking the Fruits row's arrow at a
  hard-coded position. The runner's apt cache is keyed on the workflow file, so a package
  list change refreshes it.
- Anything: the `-desktop`, `-text`, `-code` and view variants are separate steps; each
  can break on its own.

Fix breakage in the scripts, keeping the previous OS's behaviour only if it still works
(the pin means there is no need to support two versions at once: **we track one OS
version per family; older releases are not a target**).

### 4. Review every new reference image by eye
Read each PNG in `../reference/<os>/` (both themes, every view, `-desktop`, `-text`,
`-code`). This step is the point of the exercise; a run that merely goes green proves
little. Check:

- the window is 490px wide logical (980px at 2x), fully in frame, with the intended
  padding around it (96px, 80px on Windows) and a plain 50% grey desktop;
- the sidebar is hidden (Windows: cannot be hidden, and isn't in the crop), the toolbar is
  the intended trimmed one, the tree is expanded, the fixture is complete (13 items in the
  default view: Fruits with Apple.md, About.txt, Animation.gif, Blot.webloc, Draft.md,
  index.html, Logo.png, Notes.md, Old report.doc, Photo.jpg, Plan.gdoc, Report.docx,
  Tasks.org) and dates are plausible and in the past;
- dark mode is actually dark (not the old GTK3-style dark on Linux), no focus rings, no
  stray dialogs, tooltips, cursors, watermarks, notification banners or console
  windows;
- shadows and corners: macOS has a real shadow and rounded corners; Windows and Linux
  have no shadow (deliberate); Linux corners are drawn by the script (12px x scale);
- the `-desktop` icon grid is neat: even columns, no overlapping, no labels cut off;
- editor captures (`-text`, `-code`) show the intended file with the OS's editor.

If an image is wrong, that is a capture bug: fix the script and rerun. Do not edit
reference PNGs by hand and do not accept a wrong capture as "the new look".

### 5. Run pane-qa and retune the skin
Reference pushes do **not** start pane-qa (bot pushes don't trigger workflows, and
its path filter ignores `reference/**`): `gh workflow run pane-qa.yml --ref <branch>`,
then `git pull --rebase` for the bot's `../rendered/<os>/` images, then
`node app/helper/pane/qa/diff.js --os <os> --explain` (see `../qa/README.md`; `diff.js`
compares what is in `rendered/`, it does not render).

Expect failures where the OS look actually changed. For each:
- **Real OS change** (new radii, colours, metrics, icons, a moved button, changed date or
  size format): update `../css/<os>.css` and `../icons/<os>/` from the new references, the
  same way the skin was built (2 physical px = 1 CSS px; zoom into the 2x reference for
  metrics; SVG icons redrawn from the `-desktop` capture; chrome as pseudo-elements and
  gradients, no extra DOM nodes). If a format changed, update `../lib/format.js` and its
  tests, and the table in `../DESIGN.md` §3. If Explorer or Finder gained or dropped a
  column or control, `lib/markup.js` may need a cell: keep the macOS output pixel-identical
  and read `../DESIGN.md` §1 first.
- **Capture drift** (a window a few pixels bigger, the clock text wider): adjust masks
  (`../qa/lib/cases.js`, checked by `../qa/tests/masks.js`) and window-rect assumptions,
  not the skin.
- Thresholds (`../qa/thresholds.json`): do not loosen a limit just to go green; if you
  must, say why in the commit and in `../DESIGN.md`'s notes, and re-tighten when the skin
  catches up. After the skin passes, tighten to just above the achieved numbers.
- Windows and Linux images are only meaningful from their own runner; iterate by pushing
  and pulling the bot's renders. (macOS can render locally.)

Also check the mobile behaviour and dark mode still hold (`../DESIGN.md` §5, §6) if you
changed metrics.

### 6. Move the pin, update the docs, merge
- `os-versions.json`: final values (and `runner`, case B). The pin, the labels and the
  values must agree; run `jasmine app/helper/pane/tests/os-check.js` and a dispatch of
  the capture for that OS to see the guard pass.
- Update the version mentions: line 3 of `../reference/resources/<os>/README.md` (runner
  and OS version), any changed capture learnings in that README, `../PLAN.md` "Phase 1"
  findings, `../reference/README.md` if the layout changed, and this file's "Facts about
  the runners" section (with the date). Search for the old numbers:
  `grep -rn "26\.6\|24\.04\|Nautilus 46\|26100" app/helper/pane`.
- Commit messages say what changed visually and in the scripts; the PR description lists
  what was retuned and which metrics changed. Mention anything a person should
  know (a deleted feature, a changed date format, a new minimum window size).
- Confirm CI: pane-screenshots for that OS is green and committed the references,
  pane-qa is green (render, unit tests, smoke test), the guard step passes for all three OSes.

## Rules
- Never move the pin without recapturing and reviewing the references.
- Never unpin (`-latest`) to make a failure go away; that is the failure mode this
  design prevents.
- Never edit `reference/` or `rendered/` PNGs by hand; both are written by CI.
- One OS per update. Windows, macOS and Linux updates are independent and can run in
  parallel on separate branches (keep `os-versions.json` edits to your OS's block).
- If the new OS makes a documented decision wrong (for example the sidebar can now be
  hidden on Windows, or Nautilus dropped the tree view), record the change in
  `../DESIGN.md` and the per-OS README, and tell the person who assigned the task.
- If you cannot make the capture reproduce the intended window, stop and report what you
  tried; the old references and pin stay valid until then.

## Quick reference
```sh
# what would move (prints "<family> <pinned> <newest>"; nothing when current)
node app/helper/pane/screenshots/check-runner-images.js
# check a machine against the recorded versions (--basic: release/build only)
node app/helper/pane/screenshots/check-os.js
# capture one OS on your branch; render; inspect
gh workflow run pane-screenshots.yml --ref <branch> -f os=windows
gh workflow run pane-qa.yml --ref <branch>
gh run list --branch <branch> --limit 5
node app/helper/pane/qa/diff.js --os windows --explain
```
