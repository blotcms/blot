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
  <ul class="pane-tree" role="list" [tabindex="0" aria-label="Your site"]>
    <li>
      <span class="pane-row [pane-odd]">
        <span class="pane-label"><i class="pane-icon pane-k-doc"></i>About<span class="pane-x">.txt</span></span>
        <span class="pane-cell pane-d"><span data-os="mac">7:11 PM</span><span data-os="win">…</span><span data-os="linux">…</span></span>
        <span class="pane-cell pane-s"><span data-os="mac">…</span><span data-os="win">…</span><span data-os="linux">…</span></span>
        <span class="pane-cell pane-t"><span data-os="win">Text Document</span></span>
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
- **Per-row cost is 1 `li`, 1 row span, 1 icon `<i>`, 1 label, 3 cells** (plus one `.pane-x` span
  inside the label on a row whose extension Windows hides, see below). Depth is not in the
  markup: indentation comes from nesting selectors (`.pane-tree .pane-row`, `ul .pane-row`,
  `ul ul .pane-row`, … six levels, deeper clamps). Zebra stripes are a build-time class
  (`pane-odd` on every second *visible* row, in document order) because `:nth-child` can't
  see across nesting; skins that have no stripes ignore it (3 bytes per odd row).
- **Cells** are one `span` per column, class-tagged, holding one child per OS (`data-os`),
  because the text differs per OS (§3). A window pinned with `os` emits only that OS's child.
  Hidden children are `display:none`, so screen readers and copy/paste see one.

  | class | column | children | shown by |
  |---|---|---|---|
  | `pane-d` | Date modified | mac, win, linux | all |
  | `pane-s` | Size | mac, win, linux | all |
  | `pane-t` | Type (Kind) | win only | win |

  Column order and which columns exist are the skin's: `order` on the cell (and on the
  matching `.pane-head i`), `display:none` for a column that OS doesn't have. macOS: Name,
  `pane-d`, `pane-s`. Windows: Name, `pane-d`, `pane-t`, `pane-s`. GNOME: Name, `pane-s`,
  `pane-d`. `base.css` hides `.pane-t` by default. It is emitted only for unpinned and
  Windows-pinned windows (no other skin shows it), and GNOME wording exists in `formatType` but
  is not emitted. `.pane-x` is emitted only on rows with a hideable extension. A skin shows a child with
  `.pane [data-os=X]{display:inline}` (base hides every `[data-os]`).
- **Extension hiding (Windows).** Explorer hides the extension of known types (`About`), not
  of others (`Draft.md`, `Blot.webloc`); the list is `hide` in `EXTENSIONS` (`lib/format.js`).
  The label stays *one string*: an unpinned window wraps just the hidden part in
  `<span class="pane-x">.txt</span>` and `win.css` sets `.pane-x{display:none}`, so a screen
  reader gets "About.txt" on macOS and "About" on Windows, never both. A window pinned to
  Windows emits `About` with no span; one pinned elsewhere emits `About.txt`. This is the one
  extra node per row and only where the extension is hidden.
- **Pins need a skin.** `os` for an OS with no skin yet (`css.SKINS`) is ignored: no
  `data-pin`, the window follows the visitor and the default skin covers the rest (§2).
- **Internal class names.** The skeleton used `pane-name` for the row label; that collides
  with the author-facing `pane-name` prose span (§8). Internal names are `pane-label`, `pane-cell`, …
- **Height.** Default: the window fits its rows, capped at the reference height (360px on
  macOS; `max-height` in the skin). The build knows the row count, so it adds `tabindex="0"`
  to `.pane-tree` only when the rows can exceed the cap (a scroller must be keyboard
  reachable). An explicit `height` (`--pane-h`) fixes the height instead. The QA adapter
  passes the reference height.
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
@light { --bg:#fff; --fg:#262626; --dim:#8a8a8a; --bar:#f6f6f6; --line:#d8d8d8; --stripe:#f4f5f5 }
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

and, for the default skin only, adds `html:not(:is([data-os=S1],[data-os=S2],…)) .pane:not([data-pin])`
over every *built* skin `S` (`css.SKINS`). So the default skin applies whenever `data-os`
is absent (no JS, the QA harness before it sets the attribute) **or names an OS whose skin
isn't built** (the head script sets `win` for Windows and `linux` for Linux visitors; until
`win.css`/`linux.css` exist those visitors get the default). It's derived from `SKINS`, so
it shrinks by itself as skins land, and it excludes every built skin, so it never applies
together with a real skin's rule. Consequences (skins built: `mac`):

| window | visitor's `data-os` | skin applied |
|---|---|---|
| no pin | `mac` | mac (via `html[data-os=mac]`) |
| no pin | absent (no JS) | the default skin (build option, `mac`) |
| no pin | `win`/`linux` while unbuilt | the default skin (via the fallback) |
| no pin | `win`/`linux` once built | that skin |
| `data-pin=mac` (built) | anything | mac (via `[data-pin]`), never the visitor's |
| `os:"win"` while unbuilt | anything | markup drops the pin (no `data-pin`): as an unpinned window |

`:not([data-pin])` guarantees exactly one path matches, so an OS rule never also applies to
a pinned window. `:is()` takes the highest specificity among its arguments, so both paths
have equal specificity and skin rules always beat `base.css` (which uses plain `.pane`
selectors). The prose rule for `.pane-name` (§8) uses the same fallback. Theme composes orthogonally: the `data-theme` selector only decides which token block
is active, and never mentions an OS. `data-pin` and `data-theme` are independent
attributes, so all six combinations work with no extra rules.

### Container queries for mobile

`.pane` is `container-type:inline-size` with `width:min(var(--pane-w,490px),100%)`.
Responsive rules use `@container` (window width), not `@media` (viewport), so a narrow
window in a wide page behaves the same as a wide window in a narrow page. See §6.

### Build output

`assets().css` is generated once per process and cached (server-side cost is irrelevant, the
output is what ships): expand skins, expand dark blocks, inline icons, minify (comments
and whitespace only; we own the source so no minifier dependency, and no dead-code removal
yet). Stage 1 emits base + mac; skins for OSes not yet built are not emitted.

## 3. Sizes and dates per OS

Implemented in `lib/format.js` (re-exported by `index.js`); all output is
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
| Type text | not shown | `File folder`, `Text Document`, `GIF File`, `JPG File`, `MD File`, `DOC File`, `Microsoft Edge HTML Document`, unknown: `XYZ File` | `Folder`, `Text`, `Image`, `HTML`, unknown: `Unknown` (not emitted) |

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
  whitespace. No size cap: as detailed as fidelity needs.
- **Traffic lights, nav pill, header dividers, shadow** are gradients and box-shadows on
  pseudo-elements, not images, so they cost bytes only once.
- If dark mode needs a different icon, the `@dark` block overrides that one background.

## 5. Accessibility

- Semantic nested `ul`/`li` (§1); no `role="tree"`.
- All chrome is `aria-hidden`; hidden per-OS text is `display:none`; decoration that must
  not be selected (`user-select:none` on `.pane-bar`, `.pane-head`, icons, glyphs).
- Visually hidden "folder" / "expanded" text via `.pane-sr` (clip-rect pattern, not
  `display:none`).
- **Contrast: fidelity wins.** Text colours are the real OS colours, even where the real OS
  is below 4.5:1 (Finder's secondary text). Contrast is *reported* by a test (not enforced)
  so the ratios are visible; we do not adjust colours to pass it.
- `prefers-reduced-motion`: the list view has no animation. Anything animated later (cursor blink)
  lives in `@media (prefers-reduced-motion:no-preference)`, so the default is static.
- `forced-colors:active`: drop shadows, stripes and the traffic lights; borders and dividers use
  system colours (`CanvasText`, `GrayText`); text uses `CanvasText` on `Canvas`; masks still
  work through `currentColor`; coloured icons get `forced-color-adjust:none`.
- Keyboard: scroller has `tabindex="0"` and the window title as `aria-label` when it can scroll (more than 11 rows, or always with an explicit `height`, §1). Focus ring is the
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

## 7. Size

**No size limit.** A faithful render is the goal; a single retina PNG is bigger than the
whole stylesheet will be, so we have budget. We still keep the CSS as small as fidelity
allows (custom properties, shared glyphs, no duplication), and `tests/size.js` *reports* CSS,
JS and per-window HTML sizes (raw and brotli) so growth is visible. The JS stays a tiny inline
`<head>` snippet. No hard budget unless we decide to add one later.

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
css/*.css  icons/  tests/{index,format,parse,markup,names,css,size}.js
```

Unit tests (fast, pure): formatters (all boundaries), parser (indent, folder rule, columns),
markup (structure, pin, escaping, `null` for unsupported views), CSS build (`@light`/`@dark`
expansion, `data-os`/`data-pin` selector wrapping, uniqueness of the matching path, default
skin), contrast (reported), and size (reported).

## Decisions (resolved in review)

1. Default height fits the rows, capped at the reference height (§1).
2. Fidelity above all: real OS colours, contrast reported not enforced (§5).
3. `@light`/`@dark` build-time directives rather than `light-dark()` (§2).
4. Stripes as a build-time class (§1).
5. No size limit; sizes are reported (§7).

## Implementation notes (Stage 1, as built)

- Cell classes are `pane-d` (date), `pane-s` (size) and `pane-t` (Type), ordered per OS with
  CSS `order`. Windows' hidden extensions are `.pane-x` (§1); `win.css` hides it. `.doc`/`.docx` keep the kind `doc` (macOS has a Word-style
  icon); `win.css` draws the generic icon for `pane-k-doc`, as in the reference.
- The OS list is `lib/os.js` (shared by `css.js` and `markup.js`, which would otherwise be
  circular); the built skins are `css.SKINS`, read live by `markup.js`, so a test can extend it.
- The contrast report from §5 is in `tests/size.js` (reported, never enforced).
- `pane-name` expansion (§8) is built: `lib/names.js`, `transform($)`, and the prose rule in `lib/css.js`.
- The macOS skin measures to the 2× reference; `qa/thresholds.json` holds `macos-light` and
  `macos-dark` to tightened limits.
- macOS icons (`icons/mac/`) are redrawn from the Tahoe references. List-size Finder icons are
  soft paper (no stroke; a faint edge and shadow in light only, hence the `-d` variants, which
  differ only by dropping that edge), a large folded flap, and a mid-grey line texture; images
  are a checkerboard (~1.5px period, measured from the capture) with a shadow, not a photo;
  the folder is a two-tone blue with a white highlight. Not reproducible in SVG: the real
  text and md thumbnails are tiny rendered document previews, so we draw generic line texture.
  A 1px-period checker is scored like noise, so the pattern phase was chosen by diff.
