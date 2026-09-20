# pane: design (Stage 1)

Settles the architecture before the skins are built. `PLAN.md` says *what* and the header
of `index.js` is the API contract; this says *how*. Where they disagree, this file wins and
`PLAN.md` gets updated in the same PR (noted inline as **plan change**).

Stage 1 builds the macOS folder window, `list` view, light and dark. Everything below is
designed for all three OSes so Stage 2 adds a skin file, not a new architecture.

## 1. DOM contract

One `figure` per window. Semantic content is a nested list. Chrome is drawn by CSS.

```html
<figure class="pane" data-view="list" [data-pin="mac"] [data-theme="dark"]
        aria-label="Your site" [style="--pane-w:…;--pane-h:…"]>
  <div class="pane-bar" aria-hidden="true">Your site</div>
  <div class="pane-head" aria-hidden="true"><i></i><i></i><i></i></div>
  <ul class="pane-tree" role="list" [tabindex="0"]>
    <li>
      <span class="pane-row [pane-odd]">
        <span class="pane-label"><i class="pane-icon pane-k-doc"></i>About.txt</span>
        <span class="pane-cell" data-c="d"><span data-os="mac">7:11 PM</span><span data-os="win">…</span><span data-os="linux">…</span></span>
        <span class="pane-cell" data-c="s">…</span>
      </span>
      <ul role="list"> …children… </ul>          <!-- only for a folder with children -->
    </li>
  </ul>
</figure>
```

Rules:

- **Semantics.** `figure` named by `aria-label`. Rows are `li`; a folder's children are a
  nested `ul` inside its `li`, so the tree structure is real and copy/paste keeps it. No
  `role="tree"`/`treeitem` (it promises arrow-key behaviour we don't implement).
  `role="list"` is set on every `ul` because Safari/VoiceOver drops list semantics from
  `list-style:none` lists. **Plan change:** list view is nested `ul`, not a `table`; the
  column headers are decorative and aria-hidden, and each cell's text is self-describing
  ("7:11 PM", "6 bytes").
- **Fixed chrome: at most 8 decorative elements per window, identical for every OS** (Stage 1
  uses 5: `.pane-bar`, `.pane-head`, three `<i>`), always `aria-hidden`. Anything more
  (Explorer's command bar, GNOME's header buttons) must be a pseudo-element or a background
  layer first; adding a node needs a written reason in this file. Column titles, window
  buttons, the navigation pill, dividers and sort chevron are `::before`/`::after` with
  `content`, gradients and `mask-image`; the per-OS strings ("Date Modified" / "Date
  modified" / "Modified") live in the skin CSS, not the HTML.
- **Per-row cost is 1 `li`, 1 row span, 1 icon `<i>`, 1 label, 2 cells.** Depth is not in the
  markup: indentation comes from nesting selectors (`.pane-tree .pane-row`, `ul .pane-row`,
  `ul ul .pane-row`, … six levels, deeper clamps). Zebra stripes are a build-time class
  (`pane-odd` on every second *visible* row, in document order) because `:nth-child` can't
  see across nesting; skins that have no stripes ignore it (3 bytes per odd row).
- **Cells** are one `span` per column holding one child per OS (`data-os`), because sizes and
  dates are formatted differently per OS (§3). A window pinned with `os` emits only that OS's
  child. Hidden children are `display:none`, so screen readers and copy/paste see one.
- **Internal class names.** The skeleton used `pane-name` for the row label; that collides
  with the author-facing `pane-name` prose span (§8). Internal names are `pane-label`, `pane-cell`, …
- **Scrolling.** `height` is `auto` by default (the window fits its rows). When the author sets
  `height`, `.pane-tree` scrolls and gets `tabindex="0"` so it is keyboard reachable; without
  a `height` there is no scroller and no tabindex. The QA adapter passes the reference height.
- **Icons.** `<i class="pane-icon pane-k-doc">`: `pane-k-<kind>` where kind comes from the
  extension via one table (`folder`, `text`, `doc`, `image`, `html`, `md`, `link`, `generic`, …).
  The folder disclosure chevron and the row's sr text are not extra nodes: the chevron is
  `::before` on `.pane-label` for rows that have children (the class `pane-open` on the
  row span; a leaf has nothing).
- **Screen-reader text.** A folder's label ends with `<span class="pane-sr">, folder</span>`
  (`, folder, expanded` when it has children). File rows add nothing.

## 2. CSS architecture

### Files

```
css/base.css    structure: box model, list reset, rows, cells, .pane-sr, pinning, container queries,
                forced-colors, reduced-motion. No colours, no fonts, no OS names.
css/mac.css     one skin per OS (win.css, linux.css in Stage 2): metrics, chrome, glyphs, icons.
lib/css.js      the build: reads the files, expands them, minifies, caches. Pure function of the
                files + options, so it is unit-tested.
icons/<os>/<kind>.svg   hand-optimised sources, inlined as data URIs by the build.
```

### Themes are custom properties

A skin declares its tokens twice and uses them everywhere with `var()`:

```css
@light { --bg:#fff; --fg:#262626; --dim:#6b6b6b; --bar:#f6f6f6; --line:#d8d8d8; --stripe:#f4f5f5 }
@dark  { --bg:#1e1e1e; --fg:#e8e8e8; --dim:#8e8e8e; … }
.pane-row { color:var(--fg) }
```

`@light`/`@dark` are build-time directives, not real at-rules. The build turns them into
the three ordinary blocks (light by default, `prefers-color-scheme:dark` unless the window
pins `light`, and `data-theme=dark` always) plus `color-scheme` so form controls and
scrollbars follow. We generate rather than use `light-dark()` because `light-dark()` can't
switch images and a custom property using it has no fallback in older browsers. A `@dark` block may
also contain full rules (e.g. a different icon), which are emitted under the same three
selectors.

### `html[data-os]`, `data-pin`, `data-theme`

Every rule in a skin file is written against plain `.pane` selectors. The build wraps skin
`S`'s rules in

```css
:is(html[data-os=S] .pane:not([data-pin]), .pane[data-pin=S]) …
```

and, for the default skin only, adds `html:not([data-os]) .pane:not([data-pin])` (no-JS
visitors and the QA harness before it sets the attribute). Consequences:

| window | visitor's `data-os` | skin applied |
|---|---|---|
| no pin | `mac` | mac (via `html[data-os=mac]`) |
| no pin | absent (no JS) | the default skin (build option, `mac`) |
| `data-pin=win` | anything | win (via `[data-pin]`), never the visitor's |

`:not([data-pin])` guarantees exactly one path matches, so an OS rule never also applies to
a pinned window. `:is()` takes the highest specificity among its arguments, so both paths
have equal specificity and skin rules always beat `base.css` (which uses plain `.pane`
selectors). Theme composes orthogonally: the `data-theme` selector only decides which token block
is active, and never mentions an OS. `data-pin` and `data-theme` are independent
attributes, so all six combinations work with no extra rules.

### Container queries for mobile

`.pane` is `container-type:inline-size` with `width:min(var(--pane-w,490px),100%)`.
Responsive rules use `@container` (window width), not `@media` (viewport), so a narrow
window in a wide page behaves the same as a wide window in a narrow page. See §6.

### Build output

`assets().css` is generated once per process and cached (server-side cost is irrelevant, the
output is what ships): expand skins, expand dark blocks, inline icons, drop unused
declarations, minify (comments and whitespace only; we own the source so no minifier
dependency). Stage 1 emits base + mac; skins for OSes not yet built are not emitted.

## 3. Sizes and dates per OS

Implemented in `lib/format.js` (currently in `index.js`, moved and re-exported); all output is
deterministic, `now` is an option with a constant default, and hashing (FNV-1a of the full path)
generates missing columns.

| | macOS Finder | Windows Explorer | GNOME Files |
|---|---|---|---|
| columns | Name, Date Modified, Size (Kind hidden) | Name, Date modified, Type, Size | Name, Size, Modified |
| bytes < 1 unit | `6 bytes`, `1 byte` | same | same |
| size ≥ 1 unit | 1000-based, whole KB (`3 KB`), MB with one decimal | 1024-based, ceil to whole KB with thousands separator (`2 KB`) | 1000-based, one decimal (`2.7 kB`) |
| folder size | `--` | blank | `N items` |
| date, today | `7:11 PM` | `9/20/2026 7:11 PM` | `Today 15:38` |
| date, other | `8/14/26` | `8/14/2026 3:25 PM` | `14 Aug 2026` |
| extensions | shown | hidden for known types (`About`) | shown |

Anything not in the table stays as in the skeleton and is covered by unit tests
(`tests/format.js`), including the boundaries (999/1000/1001 bytes, 1023/1024, midnight,
12 AM/PM, singular "1 item"). English formats only (locale support is in "Later").

## 4. Icons

- **Monochrome UI glyphs** (chevrons, sort arrow, back/forward, search, window buttons):
  `mask-image:var(--g-chev)` with `background:currentColor`, so one path serves every state
  and both themes and forced-colors gets `currentColor` for free. Glyph URIs are custom
  properties on `.pane` (declared once, reused, deduplicated by the build).
- **Coloured file and folder icons**: SVG as `background-image:url("data:image/svg+xml,…")`,
  one per kind per OS, drawn from the 2× references (zoomed), not scaled bitmaps. No PNG
  anywhere. Encoding: percent-encode only `<`, `>`, `#`, `%`, quotes → `'`, collapse
  whitespace. Budget ≤ 700 bytes raw per icon, ≤ 12 kinds per OS.
- **Traffic lights, nav pill, header dividers, shadow** are gradients and box-shadows on
  pseudo-elements, not images, so they cost bytes only once.
- If dark mode needs a different icon, the `@dark` block overrides that one background.

## 5. Accessibility

- Semantic nested `ul`/`li` (§1); no `role="tree"`.
- All chrome is `aria-hidden`; hidden per-OS text is `display:none`; decoration that must
  not be selected (`user-select:none` on `.pane-bar`, `.pane-head`, icons, glyphs).
- Visually hidden "folder" / "expanded" text via `.pane-sr` (clip-rect pattern, not
  `display:none`).
- **Contrast**: every text/background pair is ≥ 4.5:1 (unit test computes WCAG ratios from
  the tokens, light and dark, including text on stripes). The real Finder's secondary text is
  ~3.4:1 (`#8a8a8a` on white); we use `#6b6b6b` (5.3:1) and accept the small QA cost, which
  we will measure. Decorative lines are exempt.
- `prefers-reduced-motion`: the list view has no animation. Anything animated later (cursor blink)
  lives in `@media (prefers-reduced-motion:no-preference)`, so the default is static.
- `forced-colors:active`: drop shadows, stripes and the traffic lights; borders and dividers use
  system colours (`CanvasText`, `GrayText`); text uses `CanvasText` on `Canvas`; masks still
  work through `currentColor`; coloured icons get `forced-color-adjust:none`.
- Keyboard: scroller has `tabindex="0"` only when it can scroll (§1). Focus ring is the
  browser's, not removed.
- Print: windows print as-is (no special handling).

## 6. Mobile

Windows scale down (`min(--pane-w, 100%)`). As the container narrows, in order:

| container width | drops |
|---|---|
| < 440px | decorative chrome: the nav pill (and the sidebar/status/toolbars on other OSes); the label column takes the space |
| < 380px | Size column |
| < 300px | Date column |
| always last | name ellipsis; then `overflow-x:auto` as a last resort, never before the above |

Thresholds are per skin (Explorer's minimum is ~386px) but the *order* is a rule. Tap targets
are irrelevant (nothing is interactive); text stays ≥ 13px.

## 7. Size budget

Measured with raw byte length and `zlib.brotliCompressSync` by `tests/size.js`, which fails
above budget (+10% tolerance for the hard limit). Numbers are targets for now; the hard limit
is set from the first measured version.

| | Stage 1 (mac) | Final (3 OS) |
|---|---|---|
| CSS, once per page | ≤ 8 KB raw, ≤ 2.5 KB brotli | ≤ 30 KB raw, ≤ 8 KB brotli |
| JS, once per page | ≤ 300 B raw (inline in `<head>`) | same |
| HTML, per window (fixed) | ≤ 400 B | ≤ 400 B |
| HTML, per row | ≤ 300 B raw (all three OS cells; ≤ 80 B brotli in bulk) | same |

A docs page with 20 windows of 15 rows is ≤ ~100 KB raw HTML from panes, of which brotli
takes most, because rows repeat.

## 8. `pane-name` text swap

Authors write `<span class="pane-name">Finder</span>` in prose. The build (`transform($)`)
expands it to

```html
<span class="pane-name"><span data-os="mac">Finder</span><span data-os="win">File Explorer</span><span data-os="linux">Files</span></span>
```

- **Lookup**: the span's text is matched (case-insensitive, any OS's spelling) against a
  small dictionary (`name`, `trash`, `modifier`, `rightclick`, …); `data-key="trash"`
  overrides. First-letter case is preserved ("the trash" / "Trash"). An unknown term is left
  untouched, and the build logs it, so a typo is a warning, not a broken page.
- Variants that are identical across OSes collapse to plain text.
- **CSS** (in `base.css`, same `data-os` machinery): `.pane-name>[data-os]{display:none}` and
  the visible child chosen by `html[data-os=X] .pane-name>[data-os=X]`, with the default
  skin shown when `data-os` is absent. There is no runtime text swapping and no flash.
- Pinned windows don't affect prose (they follow their own pin, prose follows the visitor).
- Known trade-off: crawlers see all three variants in the HTML.
- Rename note: this class is author-facing only; internal row parts use `pane-label`.

## 9. Files and tests

```
index.js        API + option docs (contract). Delegates to lib/.
lib/parse.js    tree + `| col | col` parsing
lib/format.js   sizes, dates, folder sizes, hashing
lib/markup.js   folder() -> html
lib/css.js      css build
css/*.css  icons/  tests/{format,parse,markup,css,size}.js
```

Unit tests (fast, pure): formatters (all boundaries), parser (indent, folder rule, columns),
markup (structure, pin, escaping, `null` for unsupported views), CSS build (`@light`/`@dark`
expansion, `data-os`/`data-pin` selector wrapping, uniqueness of the matching path, default
skin), contrast, and size budget.

## Open questions and defaults I'll proceed with

1. Default height `auto` with the QA adapter passing the reference height (the references clip
   mid-row; in docs a fitted window is nicer).
2. Contrast wins over fidelity for secondary text (§5).
3. `@light`/`@dark` directives rather than `light-dark()` (§2).
4. Stripes as a build-time class (§1).
5. Hard size limit is set after the first measurement.
