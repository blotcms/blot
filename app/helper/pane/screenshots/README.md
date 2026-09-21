# Capture pipeline

Scripts that screenshot the real file managers on GitHub-hosted runners. They produce
`../reference/`, the ground truth for pane. Per-OS details of *what* each script does
(window setup, retina, desktop icons) are in `../reference/resources/<os>/README.md`;
this file is about running and changing the pipeline.

| file | runs on | output |
|---|---|---|
| `macos.sh` (+ `hidpi.m`) | `macos-latest` | `reference/macos/` |
| `windows.ps1` | `windows-latest` | `reference/windows/` |
| `linux.sh` | `ubuntu-latest` | `reference/linux/` |
| `make-fixture.sh`, `fixture-assets/` | all (Windows builds the same fixture in PowerShell) | the "Your site" sample folder |

Workflow: `.github/workflows/pane-screenshots.yml`. It captures light and dark at 2x,
then a `commit` job pushes the PNGs and `capture-logs/` (logs and debug screenshots,
kept in `reference/resources/<os>/capture-logs/`) back to the branch as a bot.

## Running it
- It triggers only on changes to `screenshots/**` and the workflow itself, so module and QA
  changes never re-run (and cancel) the matrix.
- A `plan` job works out which OSes need capturing from the changed files (a
  `macos.sh` edit doesn't spend Windows and Linux minutes; shared files run all). On
  a new branch or an API error it runs everything.
- Manual run of one OS: `gh workflow run pane-screenshots.yml --ref <branch> -f os=windows`
  (`all|macos|windows|linux`). Watch with `gh run watch <id>`; a full capture takes about
  10 minutes per OS, so batch script changes instead of iterating one line at a time.
- The `commit` job only replaces the OSes that ran and retries its push with
  `git pull --rebase` (people, agents and the pane-qa bot push to the same branch). Pushes
  made with `GITHUB_TOKEN` do not trigger workflows: **new references do not start
  pane-qa**, run it yourself (`gh workflow run pane-qa.yml --ref <branch>`).
- `concurrency` cancels an in-progress run for the same ref: a second push during a
  capture kills it. Debug on a quiet branch.
- Look at `capture-logs/<os>-<theme>-2x/` after any failure or odd image: process lists,
  UI Automation dumps, full-screen debug PNGs. Add more logging rather than guessing.

## Runner quirks worth knowing
- **Windows can't check out this repo** (a filename contains `|`). Jobs download the
  scripts with `raw.githubusercontent.com` or unpack `app/helper/pane` from the tarball
  (see both workflows). `windows-11-arm` is stuck on first-run setup: don't use it.
- **macOS runs Bash 3.2.** Nested double quotes inside `$(...)` (for example
  `echo "x=$(node -e "...")"`) are mis-parsed; put the script in single quotes and assign
  to a variable first. `${var,,}` and other Bash 4 features don't exist either.
- **Linux:** `pkill -f gnome-text-editor` kills the capture script itself (its own command
  line contains the string): use `pkill -x gnome-text-edit`. There is no compositor under
  Xvfb (picom crashed), so no shadow and no rounded corners; the capture rounds corners
  and deliberately adds no shadow.
- **Runner images move.** macOS 26.x, Ubuntu 24.04 (Nautilus 46, one GNOME release behind)
  and Windows Server 2025 drift; a recapture after an image update can change pixels
  without any change here (the bot commits will show binary churn). Explorer's default
  window width changed by 10px between two captures for no reason we found.
- **Time leaks into captures** (dates, clock, "Today"); keep anything that must be stable
  out of the crop or masked (see `../qa/README.md`, masks).
- Desktop-icon captures (`-desktop`) need each OS's desktop emptied first and the fixture
  copied in last; Windows Explorer restarts reset `HideIcons`, so the script empties the
  desktop instead of hiding icons. Details in the per-OS READMEs.

## pane-qa (the other workflow)
`.github/workflows/pane-qa.yml` renders pane's output for every case on the matching runner
(so system fonts line up), commits `../rendered/<os>/`, runs the unit tests and the viewer
smoke test, and prints a diff summary. Notes:
- Its dependency list is computed from the root `package.json` and cached (`node_modules`
  and Puppeteer's Chrome); a change to that list busts the cache.
- The smoke test presses view-mode keys quickly, which makes the viewer cancel the live-HTML
  iframe request; aborted requests (`ERR_ABORTED`) are not failures.
- Windows and Linux images are only trustworthy from their own runner; never regenerate
  them on macOS.
