# pane: notes for agents

Start here. This file is what is *not* obvious from the other docs; it points to them
rather than repeating them.

| read | for |
|---|---|
| `PLAN.md` | what pane is and why (goals, scope, later items) |
| `DESIGN.md` | how it is built: DOM contract, CSS architecture, per-OS formats, a11y, implementation notes. **Wins over PLAN.md.** |
| `index.js` header | the public API contract |
| `qa/README.md` | the comparison harness (cases, metrics, viewer, adapter) |
| `reference/README.md`, `reference/resources/<os>/README.md` | what the reference screenshots are and how each OS was captured |
| `screenshots/README.md` | the capture pipeline and CI (workflows, runners, gotchas) |
| `screenshots/UPDATING-OS.md` | **procedure for moving to a newer macOS/Windows/Ubuntu**; the CI guard (`check-os.js`) points here when a runner's OS changes |

## The one rule that explains most decisions
**Fidelity to a real capture wins.** The references are real screenshots taken on real
OS runners, and the rendered HTML is judged against them. When a reference and your idea
of the OS disagree, the reference is right (example: `.doc`/`.docx` show "DOC File" with
the extension visible and a generic icon on Windows, because the capture runner has no
Word; a Word-installed variant is a "Later" item, not a bug). Real OS colours also beat
WCAG contrast; contrast is reported by `tests/size.js`, never enforced.

## Who owns what
- Skins are per-OS files: `css/<os>.css` + `icons/<os>/`. `css/base.css` is structure
  only. `lib/` is shared and small; edit it surgically, because other agents work there
  in parallel.
- `reference/` and `rendered/` PNGs are written by bots (pane-screenshots, pane-qa). Never
  edit or regenerate them by hand; bot commits land on the branch at any time.
- `app/documentation/tools/finder` (the module this replaces) stays untouched until every
  view has migrated.

## Working loop (and its traps)
1. Install `puppeteer sharp pixelmatch express jasmine cheerio` at the versions in the
   root `package.json` into a scratch directory and set `NODE_PATH` to its
   `node_modules`. The repo has no local install for these.
2. Unit tests: `jasmine "app/helper/pane/tests/*.js" "app/helper/pane/qa/tests/*.js"`.
   pane-qa CI runs them on every push under `app/helper/pane`.
3. **`qa/diff.js` compares the reference with whatever is already in `rendered/`; it does
   not render.** After changing CSS or markup, run `qa/render.js --case <id>` first (the
   macOS cases locally). Otherwise you are measuring the last CI render and will "verify"
   a change that never reached the image. This is the easiest mistake to make here.
4. **Local Chrome has your machine's fonts.** Windows (Segoe UI Variable) and Linux
   (Cantarell) cases are only meaningful when rendered on the matching runner: push, let
   pane-qa render them, `git pull --rebase`, then diff. Locally they check structure only.
5. The pane-qa run for a push is cancelled by the next push to the same branch
   (`concurrency` is per ref). Agents working in parallel therefore use separate
   branches and merge into `pane-screenshots-spike` at milestones.
6. **Reference changes don't re-render.** pane-qa ignores `reference/**` and
   `rendered/**` in its path filter and bot pushes don't trigger workflows. After a new
   capture lands, start pane-qa yourself: `gh workflow run pane-qa.yml --ref <branch>`.
7. Check CI with `gh run list --branch <branch> --workflow pane-qa`; the failing step's
   log is in `gh run view <id> --log-failed`.

## Gotchas in the module
- **Accessibility and mobile (DESIGN.md §5, §6).** `node app/helper/pane/qa/a11y.js` audits every skin
  (named window, focusable scrollers, forced colours, narrow widths); run it after any change to a
  skin's layout or a column. Text that gets longer (new date forms, longer names) is the usual way to
  break it: cells truncate with an ellipsis instead of overflowing.
- **Backdrop independence (DESIGN.md §10).** A window must look right on any desktop, not only
  the grey of the references: exterior effects (shadow, ring, corners) are alpha or clipping,
  never the desktop colour. `node app/helper/pane/qa/backdrop.js` checks it (black vs white
  render); run it after touching a skin's window edge, shadow or `background`.
- **Time-dependent text.** Reference dates are relative to capture time (files are
  back-dated, but "Today 10:52 PM" and column widths depend on when the job ran). The date
  columns are masked (`qa/lib/cases.js`, `qa/tests/masks.js`). A mask sized for "2:35 PM"
  cut through "10:52 PM" once; size masks for the widest possible time.
- **Skin selectors.** Every skin rule is written against `.pane` and wrapped by
  `lib/css.js` in a `:is()` group of equal specificity: `html[data-os=X] .pane:not([data-pin])`
  or `.pane[data-pin=X]`. The default skin also covers visitors whose skin isn't built
  (`unbuilt()`), derived from `SKINS`, so adding an OS to `SKINS` is the switch that
  stops the fallback *and* makes `os:` pins hold (`markup.js` reads `SKINS` live and warns
  when it drops a pin).
- **`@light`/`@dark` are build directives, not CSS.** `@dark` may hold declarations
  (tokens) and full rules; the build emits them under `prefers-color-scheme` (unless the
  window pins light) and under `data-theme=dark`. Skin files must be parsed by
  `items()`: keep statements before nested blocks, no comments containing `{`/`}`.
- **The minifier is deliberately dumb** (whitespace and comments only). It collapses runs
  of spaces, including inside `content:"..."` strings, and strips spaces around `> , { } ;`.
- **Icons** are `url(icon:<os>/<name>)`, inlined as percent-encoded data URIs, so each SVG
  must be standalone (its own gradient ids are fine). No raster data, no `<image>`.
- **Per-OS cells.** One child per OS in `<span data-os>`; a window pinned to an OS emits only
  that OS's child, and skips cells no skin can show (the Type cell is Windows-only). An
  unpinned window's markup is therefore not byte-identical across builds of the module,
  only its rendering is; don't write tests that pin its exact bytes.
- **`transform($)`** never throws for author input. Unknown `pane-name` terms and dropped
  pins log a warning and render something sensible.
- **Metrics that were hard to see:** all references are 2x (2 physical px = 1 CSS px); the
  window is measured from the detected window rect, not the image edge; an icon with a
  1px-period pattern is scored as noise by the diff (macOS image icon phase was chosen
  by diff, treat it as tuned to the metric, not to the eye).
- **Sizes:** `tests/size.js` prints CSS/JS/HTML sizes; there is no budget but watch for
  jumps (`css` about 32 KB raw, 2.8 KB brotli with the mac skin).

## Before this PR leaves draft
- Restore the workflows that were removed to keep CI fast on this branch (benchmarks-*,
  build, deploy, integration, node, proxy, screenshots): `git checkout master --
  .github/workflows/`, then re-check that pane-qa and pane-screenshots are still wanted.
- Remove the root `TODO` entry for this work and, per `CLAUDE.md`, add any "tell someone"
  item to the PR description.
- Decide whether `rendered/` stays committed (it makes the viewer work without Chrome at
  the cost of binary churn), and whether the capture workflows stay.
