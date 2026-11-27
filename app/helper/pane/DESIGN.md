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
css/mac.css     one skin per OS (win.css, linux.css): metrics, chrome, glyphs, icons. A skin may span
                several files, read as one source in name order: css/<os>.css (the folder list view) plus
                css/<os>-<part>.css (mac-icons.css, mac-editor.css, ...), so parts can be built independently.
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
| date, yesterday | `Yesterday` | absolute | `Yesterday 15:38` (widens the Modified column by 22px: class `pane-yd`) |
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

Thresholds are per skin (Explorer's minimum is ~386px) but the *order* is a rule. A skin with a border and padding on `.pane` (GNOME: 1px + 4px each side) writes its `@container` widths 10px lower than the table, because the container is the content box: window minus border and padding. Tap targets
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

## 10. Backdrop independence

Windows will one day sit on wallpapers (a painting crop, a gradient), not only the plain grey
of the references. The rendering must not depend on the desktop behind it:

- **Nothing outside the window box paints or assumes the desktop colour.** Shadows, hairlines
  and glows are `rgba()` (or an opaque hairline that is the window's own edge, like macOS
  dark's `#070707` ring); corners come from `border-radius` clipping, never a mask filled
  with grey; no full-bleed layer or `box-shadow` spread. Any `#808080` in a skin's *exterior*
  effects is a bug (the QA harness's `#808080` is only the reference backdrop).
- **Inside, the window is opaque today.** Real OS chrome is partly translucent (Windows 11
  Mica in the title strip, macOS materials); our skins use opaque colours sampled from the
  references, which were captured over 50% grey. On another wallpaper that chrome looks
  neutral instead of tinted. That is accepted for now. Keep those colours as tokens.
- **Known refactor point:** `.pane` paints one opaque `background`. A translucent surface
  needs `backdrop-filter` on a layer over a semi-transparent tint, and a child's backdrop
  filter samples what is painted behind it, so the opaque fill has to move from `.pane`
  to the regions that are opaque (list area, toolbar body) and leave the material layers
  alone. Calibration note: a tint that must reproduce a near-white chrome over mid-grey
  can only be about 92% opaque or more, so a translucent skin fitted to grey references is
  mostly a guess; the plan is to capture each OS on black and white desktops (PLAN.md,
  "Wallpapers").
- **Windows and Linux windows have no shadow** (the references have none, by decision). On a
  wallpaper they look flat; a wallpaper mode would add an alpha shadow only when a backdrop is
  set.
- **The guard:** `qa/backdrop.js` (and `tests/backdrop.js`, run in CI) renders each default
  case's window on black and on white and checks the matte: opaque inside, clear more than
  72px outside, transparent corners on rounded windows. Intended translucency goes in
  `qa/backdrop.json` (per case, rectangles in CSS px). It also writes `cutout.png` (the window
  with real alpha) to `qa/out/<id>/`, which composites onto any image.

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
- The Windows skin (`css/win.css`, `icons/win/`) builds the Explorer Details view; measurements are CSS px from the
  window's top-left, taken from the 2x reference. The window is 504x367: a 6.5px Mica frame around a 491px client
  area (the "490" in the capture notes), so `.pane` defaults to `--pane-w:504px` / `--pane-max:367px`. Chrome is
  layered backgrounds on `.pane-bar` (tab strip, navigation row, command bar: one element, 136px, each layer a
  custom property so a container query can drop layers) and on `.pane` (status bar and view toggles), plus
  pseudo-elements: `.pane-bar::after` is a three-layer `mask` (left glyph sprite, and two right-anchored sprites so
  the window buttons and search glyphs stay at the right edge), `.pane::before` is the address text
  (`content:attr(aria-label)`, so it follows the window title), `.pane-bar` itself shows the title as the tab text.
  No chrome node was added (still 5). Two-tone glyphs (disabled command icons, Details) are coloured SVG sprites
  (`bar.svg`/`bar-d.svg`, `details*.svg`, `status*.svg`, `tab*.svg`): the theme changes their colours, so each has a
  `-d` twin selected by an `--i-*` token in `@light`/`@dark`.
- Fixed decoration in the Windows window: the **Details** label, the search placeholder and the command-bar labels
  ("New") are constant strings in the CSS. The status bar's **item count is not**: `.pane-tree` resets a CSS counter, each
  top-level `li` increments it, and `.pane-tree::after` (absolutely positioned against `.pane`, so it neither scrolls
  nor is clipped) prints `counter(items) " items"` (singular for a lone row, via `:has(>li:only-child)`), so it is
  right for any window and needs no node. It cannot be `.pane::after`: `.pane` is a size container, and its style
  containment keeps counters from reaching its own pseudo-element (it printed "0 items"). (Explorer counts the folder's
  own items, i.e. the top-level rows; the reference has 13.) Tested in Chrome in `tests/win.js`.
- The Windows list is always wider than its window (628px of rows in a 491px area), so `folder()` makes it a
  keyboard-reachable named scroller (`tabindex="0"` + `aria-label`) whenever a Windows skin can apply (unpinned or
  pinned to `win`). The cost is one extra tab stop for macOS and Linux visitors; a window pinned to `mac` or `linux`
  has none unless it can scroll. Firefox has no `::-webkit-scrollbar`, so `@supports not selector(::-webkit-scrollbar)`
  gives it `scrollbar-width:thin` and `scrollbar-color` in the skin's colours (Chrome ignores the webkit rules once
  those properties are set, hence the gate).
- Explorer's Details view cannot expand a folder and always lists folders first, so `win.css` sorts folders first with
  CSS `order` (`li:has(>.pane-row .pane-k-folder)`), leaving the DOM order alone. Nested rows are still shown
  (indented by `--step`, no chevron): the docs use them to show a structure, so nothing is hidden. The QA sample
  for Windows lists the top level only, as the reference does.
- Scrollbars are real: `.pane-tree` overflows (the rows are 627.5px wide, Name 271.5 + Date 144 + Type 125 + Size
  87, so the Size column is cut off by the window edge and a horizontal scrollbar appears, as in the capture), styled
  with `::-webkit-scrollbar` to Explorer's 16.5px track and 2.5px thumb. The `:vertical`/`:horizontal`
  pseudo-classes do not match under the `:is()` the build wraps rules in, so the thumb and the buttons use plain
  `::-webkit-scrollbar-thumb` / `-button` rules (a border shrinks the thumb on both axes). Headless Chrome hides
  scrollbars by default, so the QA renderer launches a second browser with them shown for Windows cases.
- Below 481px the search box, More and Details go; below 440px the navigation row and command bar go (the tab strip
  and window buttons stay) and the Type and Size columns drop; below 300px the Date column drops (§6).
- GNOME Files skin (`css/linux.css`, `icons/linux/`): Nautilus 46 in its narrow layout (490px, sidebar
  collapsed), so the view and back/forward buttons are in a bottom bar, drawn by `.pane::before`
  (line, scroll shade, divider) and `.pane::after` (a mask sprite with a two-tone background: the
  disabled back/forward chevrons, then the view and options glyphs). Header glyphs are one mask sprite
  per side of `.pane-bar::after` (left anchored, right anchored) so the pill can shrink; the pill and
  its "Home" text are `.pane-bar::before`, and the window buttons are radial gradients on `.pane-bar`.
  No new DOM nodes. Rows are 52px with 32px icons; a star column (`.pane-row::after`) is shown as in the
  reference and drops first when narrow. The window edge (1px line, 3px ring, 1px line) is background
  layers with square inner corners, as in the capture. The scrollbar thumb is a fixed decoration
  (shown only when the list can scroll); it does not move, and the native scrollbar is hidden.
  Text is Cantarell 11pt (14.67px) as in the references (`screenshots/linux.sh` sets it).
  Icons are redrawn from the desktop-icon study; shadows are an SVG blur, not per-theme variants.

### Icons view (`view:"icons"`), macOS built; the contract for the other skins

Built as css/mac-icons.css on the shared markup below. Windows and Linux add `css/win-icons.css` /
`css/linux-icons.css` and change nothing else (no JS, no markup, no `base.css`).

**DOM (identical for every OS, no per-OS text)**

```html
<figure class="pane" data-view="icons" [data-pin] [data-theme] aria-label="Your site" [style="--pane-w;--pane-h"]>
  <div class="pane-bar" aria-hidden="true">Your site</div>
  <div class="pane-head" aria-hidden="true"><i></i><i></i><i></i></div>      <!-- same 5 chrome nodes -->
  <ul class="pane-tree" role="list" [tabindex="0" aria-label="Your site"]>
    <li><i class="pane-icon pane-k-doc" [data-ext="ORG"]></i><span class="pane-label">About<span class="pane-x">.txt</span><span class="pane-sr">, folder</span></span></li>
  </ul>
</figure>
```

- **Top-level rows only.** Real icon views (Finder, Explorer's medium icons, Nautilus) can't expand a
  folder in place, so children of folders are dropped from the markup (not hidden: they'd be read by
  screen readers and copied). The folder icon shows nothing about them, as in all three captures. The
  docs' tree syntax stays the source, so switching a block between `list` and `icons` needs no
  rewrite. A folder's sr text is `, folder` (never `, expanded`).
- **Per item: 1 `li`, 1 `i.pane-icon` (`pane-k-<kind>` as in the list view), 1 `span.pane-label`.**
  No `.pane-row`, no `.pane-cell`s, no `pane-odd`, no `pane-yd`, no `data-os` children: the icons view
  shows the label only. The label is one string per OS as in the list view (`.pane-x` wraps the
  extension Windows hides, for unpinned and win-pinned windows; `.pane-sr` for folders).
- `data-ext` (uppercase extension) is on the icon of a *generic* file (kind `generic` with an extension):
  macOS prints it on the page icon (`ORG`, `GDOC`) from `::after{content:attr(data-ext)}`. Other OSes
  ignore it. A link icon's "HTTP" is a constant in the skin.
- `.pane-head` is kept (a fixed chrome node) and is `display:none` in every icons skin: column
  headers exist only in the list view. `base.css` stays view-agnostic (it has no icons rules).
- **Scroller**: `.pane-tree` is `tabindex=0` + `aria-label` when there are more than 4 items (rows
  depend on width, so it can't be known; one row of the default window holds 4 on macOS) or with an
  explicit `height`. The default height fits the rows, capped at the skin's `--pane-max`.
- The window height in the QA case is the reference's; `pane-adapter.js` renders the icons cases from a
  tree of the items Finder's capture shows (its hand-placed layout has a fifth column cut by the window
  edge and two items off-screen; a reflowing grid can't copy that, so `qa/masks.json` masks the cut
  column and the three tiny-text previews, kind `artifact`/`preview`).

**Grid rules (skin CSS; the structure is the same on every OS)**

`.pane[data-view=icons] .pane-tree{display:grid;grid-template-columns:repeat(auto-fill,<cell w>);grid-auto-rows:<cell h>;justify-content:start;padding:…}`,
`li` a centred flex column (icon, then label), `.pane-icon` a block of the OS's icon size, `.pane-label`
`display:-webkit-box; -webkit-line-clamp:2` (two lines, end ellipsis; Finder truncates in the middle,
CSS can't, and `overflow-wrap:anywhere` breaks names with no spaces) in a fixed two-line box so cells
stay aligned. Columns follow the container width with no JS; the chrome's container-query drops
(§6) still apply, and the grid just has fewer columns. No selection or hover state (none in the
captures). Rules are scoped `[data-view=icons]` and must override the skin's list rules for the same
elements (`.pane-icon` is absolutely positioned in list rows; `.pane-label` has a fixed width and
`flex:1` in the narrow container queries; `.pane-tree` padding). In dark mode the mac list rules
re-set `.pane .pane-k-<kind>` icons under `:not([data-theme=light])`, so icons rules use
`.pane[data-view=icons] .pane-icon.pane-k-<kind>` (one class more).

**What the skin decides**: icon artwork (`icons/<os>/big-*.svg`, standalone SVG, 64×64 viewBox), cell size,
paddings, label font/colour, the shadow token. macOS metrics (measured on the 2× capture, CSS px):
cell 112×112, grid padding 14 top / 10 left / 8 bottom, icon box 64×64 (page 42×56, image 56×42, folder
60×47, at 4px from the box top for pages), 7px between icon and label, label 12px/16px, width 104,
`--fg`; the icon shadow is `--ish: drop-shadow(0 1px 1.5px rgba(0,0,0,.18))` in light and `none` in dark (pages
are pure white in both); the checker is 3.5px cells (#9a9a9a on white). Kinds: `text` a blank page (a
tiny mark), `md` a page with faint lines, `doc` a blank page, `html` a page with `</>`, `generic` a
folded-corner page with `?` and the extension, `link` the same with a globe and `HTTP`, `image` the
checker, `folder` the blue folder. Real thumbnails (tiny rendered text) are not reproduced.

**Skins without the view (the fallback, `lib/css.js`)**: a skin has a view when `css/<os>-icons.css`
exists (`css.viewsOf(os)`). `group(os)` adds `:not([data-view=<v>])` for a view the skin lacks, and the
default skin's group adds `html[data-os=<other>] .pane[data-view=<v>]:not([data-pin])` for every
other skin's missing view. So today a Windows or Linux visitor sees the *mac* window (chrome and
icons) for an icons block, a complete window that passes the audit, until their skin lands; an
`os` pin for a skin without the view is dropped with a warning (as for an unbuilt skin). Adding the
file is the whole switch.

**What `css/<os>-icons.css` must supply**: (1) `.pane[data-view=icons] .pane-head{display:none}` (or the
OS's own use of it); (2) the grid on `.pane-tree` with its padding, and anything the list skin does to
`.pane-tree` reset (`overflow`, the status-bar counter `::after` can stay: it counts top-level `li`,
which now are the items, as Explorer does); (3) `li`, `.pane-icon` (size, `position:relative`, `background`
per kind, `filter` if it wants a shadow) and `.pane-label` (two-line clamp, centred, font/colour);
(4) the icon artwork for the 8 kinds (+ `-d` variants via `@dark`), and the ext caption if the OS
prints one; (5) folders first: the list skins sort with `li:has(>.pane-row .pane-k-folder)`, which
matches nothing here, use `li:has(>.pane-k-folder){order:-1}`; (6) the `@container` drops
of the chrome as in the list skin (the label/columns ones don't apply); (7) tokens in `@light`/`@dark`
of its own file (files of one skin are joined; each `@light`/`@dark` body now gets its own `;`).
Also extend `qa/pane-adapter.js` (drop the `c.os !== "macos"` line in the icons branch and give the
OS its tree) and `qa/thresholds.json`, and `qa/backdrop.js`'s icons filter. Windows' Explorer hides
extensions of known types (already in the label markup) and has no Type/Size text in this view.

### The Blot study: selection, thumbnails, long names, large icons (macOS; folded in from two design studies)

Two studies of the Blot folder in Finder (`template-patterns/patterns/brochure/logos` and `software-hero`) showed what
the icons view lacked. All of it is macOS skin and `lib/markup.js`; other OSes fall back to the mac window as for the
rest of the icons view. The studies' comparison UI (sliders, crossfade, diff tables) is not ported: `qa/` does that.

**Source syntax: row attributes.** A pipe field in square brackets is an attribute of the row, not a column
(`lib/parse.js`; `node.attrs`): `Blot | [selected]`, `Toucan.jpg | [img=/images/toucan.jpg]`. Attributes can sit among the
columns (`Apple.md | 2 KB | [selected]`) and are not counted as one.

- **`[selected]`** (icons, desktop and list). Icons view: `li.pane-sel`, a grey backing (1/8 larger than the icon, so 72px
  at 64px icons, 144px at 128px; `--selbg` `#e6e6e6` light, `#313131` dark) drawn by `li::before` behind the icon, and a
  blue pill (`--selpill`, `#0064e1` / `#0059d2`) that hugs the name (`width:fit-content`) with white text. List view:
  `.pane-row.pane-sel`, the row filled blue (`--sel`), white text, secondary columns 82% white, white disclosure
  chevron. Screen readers get `, selected` (a `.pane-sr`). It is the *active* selection (key window); Finder's grey
  inactive selection is not drawn. The studies' four states (light/dark x default/selected) are the two themes of one
  window, so there is no `theme` marker beyond the existing `theme` option.
- **`[img=URL]`** (icons and desktop): the picture is the icon. The one extra node: an `<img alt="" loading="lazy">` inside
  the icon `<i class="pane-icon pane-k-<kind> pane-th">`; the label still names the file. The skin keeps the picture in
  proportion inside the icon box (max 7/8 of it) in a thin white frame with a shadow (`--thsh`). Only http(s),
  protocol-relative, relative paths and image data URIs are accepted; anything else is dropped and the kind's icon shows.
  The list view ignores `img` (its 16px icons stay).

**Options.** `iconSize:"large"` (HTML: `data-icon-size="large"`) puts the icons view and desktop at 128px icons (class
`pane-lg`: `--is:128px;--k:2;--cw:176px;--lw:168px`; the artwork is vector, scaled; px-drawn captions scale with `--k`).
`toolbar:"view"` (`data-toolbar="view"`) adds Finder's view-mode button to the toolbar: a glass pill with the icon-grid
glyph and a chevron, drawn on the existing `.pane-head` node (hidden in the icons view otherwise), class `pane-vb`.
It is off by default because the icons capture (`macos-*-icons`) has back/forward only; the Blot study captures have it.

**Names.** Finder wraps a name over two lines and shortens a longer one in the middle (`longer-n...cated.jpg`). CSS cannot
truncate in the middle, so the build splits a name whose estimated width (a per-character-class estimate of 12px SF Pro,
`estimate()` in `markup.js`) exceeds 190px, more than two 104px lines can hold, into `.pane-m` (the start) and `.pane-e`
(the last extension + 5 characters). `.pane-m` is clipped to two lines; a float with `shape-outside` that begins at the
second line (`.pane-m::before`, `--n` characters wide) reserves the room, and `.pane-e` is positioned there after an
ellipsis (`::before`). The text stays whole (start + end, in order) for copy and screen readers, and it works on any
background (no masking of the clamp's own ellipsis). Known difference: the first line breaks at hyphens and spaces as
text does, so a long word that does not fit leaves a gap before the ellipsis on the second line, where Finder fills the
line to the character. A name that fits two lines, or that the estimate puts just under the limit, keeps the plain
two-line clamp with an end ellipsis. A scroller rule follows the size: large icons hold two to a row in the default
window, so more than two items make the list a focusable scroller.

**Reflow and sizing.** The grid is `repeat(auto-fill, cell)` left-aligned at Finder's fixed spacing, so icons reflow as the
window narrows (`tests/blot-icons.js` checks 4, 3 and 6 columns at 567, 440 and 700px). The study stretched its columns
(`minmax(16.5cqw,1fr)`) because it scaled everything with the stage; real Finder does not, and the captures win. Window
size is the existing `width`/`height`; the study's window is 567x410.

**Captures** (`screenshots/macos.sh`, section "Blot icons study"): a folder named `Blot` holding a `Blot` folder, the three
study photos (downscaled copies in `fixture-assets/hero/`), `Post.md` and `Atlas.html`, in icon view, by name, with the
toolbar reset to back/forward, flexible space and the view-mode button (`com.apple.finder.SWCH`) *after* the list and
icons captures (their toolbar is unchanged). Per theme: `-hero` (64pt, nothing selected), `-iconssel` (Blot and
Toucan.jpg selected), `-large` (128pt) and `-largesel` (Blot selected), plus `-listsel` in the existing list window
(the Fruits row selected). Finder's order is by name (Atlas.html, Blot, fly-...jpg, Post.md, Toucan.jpg, weaver-...jpg), not
the study's hand placement. `qa/pane-adapter.js` renders the same tree; the two page previews are masked
(`qa/lib/cases.js`, kind `preview`).

### Desktop view (`view:"desktop"`), macOS built; the contract for the other skins

Icons loose on the page, no window at all: an author asks for this over a `<background>` (or any
other page background) instead of the Finder card the icons view draws. Built as `css/mac-desktop.css`
on the same flat item list `lib/markup.js`'s `items()` already builds for the icons view; Windows and
Linux would add `css/win-desktop.css` / `css/linux-desktop.css` and change nothing else, exactly as
the icons view's other skins would.

**DOM**: identical to the icons view's `<figure class="pane" data-view="desktop" …>`, except the two
chrome nodes (`.pane-bar`, `.pane-head`) are never emitted — there is no bar or traffic lights to hide,
so `lib/markup.js`'s `folder()` skips them outright for this view rather than hiding them with CSS
(DESIGN.md's usual `pane-bare`/`chrome:false` pattern hides chrome the visitor could otherwise see;
here there is truly nothing there). The body is `items()`, unchanged from the icons view.

**Positioning is the caller's job, not pane's.** `.pane[data-view=desktop]` resets the window box
(`position:static`, `width/height:auto`, no shadow/border/background, `overflow:visible`) so the
element carries no leftover Finder-card geometry, but it does not lay itself over anything — a docs
page composing icons behind another window (as `/how` does) must position a *wrapper* around the
`<pre>`, never the `.pane[data-view=desktop]` element itself: pane's own skin rules for that selector
(position, display, sizing) are scoped through `css.js`'s `.pane`-rooted, per-OS `:is(...)` wrapper and
so outrank a plain page-level selector targeting `[data-view=desktop]` directly (`app/views/css/blot.css`'s
`.pane-desktop-layer` is the example: an ancestor `<div>` gets `position:absolute`, the pane inside it
stays untouched).

**Legibility.** There is no card behind the labels, so `.pane-label` is white with a text-shadow and
`.pane-icon` gets a drop-shadow, instead of the icons view's plain dark-on-white. This is a flat stand-in,
not a capture-matched value (PLAN.md, "Wallpapers", "Desktop icon labels"): the real alpha text shadow
measured off a wallpaper is later work, gated on the two-backdrop capture plan in the same section.

- **Editor windows** (`pane.text`, `pane.code`; `lib/editor.js`, `lib/highlight.js`; macOS skin `css/mac-editor.css`;
  structure in `css/base.css`). One contract for all three OSes, so the Windows and Linux skins are CSS only.

  ```html
  <figure class="pane pane-ed [pane-bare]" data-view="text|code" [data-lang="html"] [data-pin] [data-theme]
          aria-label="Essay.txt" [style="--pane-w:…;--pane-h:…"]>
    <div class="pane-bar" aria-hidden="true">Essay.txt</div>     <!-- not emitted when chrome:false -->
    <div class="pane-head" aria-hidden="true"></div>              <!-- ditto; empty, for a skin's second chrome row -->
    <pre class="pane-body" [tabindex="0" aria-label="Essay.txt"]>the text, escaped</pre>                  <!-- text -->
    <pre class="pane-body" …><code><span class="pane-l">line <span class="pane-t-t">…</span></span>
    <span class="pane-l">next line</span></code></pre>                                                     <!-- code -->
  </figure>
  ```

  - **Options** (`opts`): `title` (file name: bar text and accessible name; default "Text"/"Code", and a code window
    with no title has an empty bar), `chrome` (default true; false = the text panel alone: no `.pane-bar`/`.pane-head`,
    class `pane-bare`), `language` (code; a highlight.js name or alias, default `html`; `text`/`plain` or an unknown name
    is shown plain, an unknown one warns), `os`, `theme`, `width`, `height` (as the folder), `now` (accepted, unused).
    Never throws: any input is coerced to text. `transform` maps the old authoring syntax: `title` -> `title`;
    `pre.text` has chrome only with class `with-chrome` (or `data-chrome="true"`), `pre.code` always (or not with
    `data-chrome="false"`); `language` comes from `data-language` or a class that names a highlight.js language
    (`<pre class="code javascript">`), else html; `data-width`, `data-height`, `data-os`, `data-theme` as for folders.
    The source is the `code` child's text (so an earlier hljs pass over it changes nothing) trimmed like a folder's.
  - **Content is text.** The body is one `pre`; whitespace, tabs and line breaks are exactly the source (`tab-size:4`),
    everything is escaped, nothing is interpreted (a leading newline is doubled, because the parser drops the first).
    Text wraps (`pre-wrap`, `overflow-wrap:break-word`); code does not (`white-space:pre`, sideways scroll). Tokens are
    inline spans and every line is an inline `.pane-l` span with the real `\n` *between* spans, so selecting or copying
    gives the source byte for byte (`tests/editor-chrome.js`, `qa/lib/audit.js` check it).
  - **Line numbers** are a CSS gutter for a skin to switch on: `.pane-l` increments the counter `pane-line`, and
    `.pane-l::before` (in `base.css`, `display:none`) prints it, `position:sticky;left:0` so it stays put while the code
    scrolls, `user-select:none`, sized by `--gut-w` (default 3ch), `--gut-gap` (1ch), `--gut-fg`, `--gut-bg` (opaque, the
    window's `--bg`, so scrolled text goes under it). A skin shows it with one declaration
    (`.pane .pane-l::before{display:inline-block}`) and sets those properties; macOS has none, as in TextEdit.
  - **Tokens.** `lib/highlight.js` runs highlight.js at build time (optional: without it, or for an unknown language, the
    code is plain escaped text and one warning is logged) and maps its scopes to 10 classes, split per line so no span
    crosses a line break: `pane-t-k` keyword, `-s` string/regexp, `-c` comment, `-n` number/literal, `-f` function/title/
    section, `-a` attribute/property, `-t` tag/name/selector, `-m` meta/doctype, `-y` type/class/built-in, `-v` variable/
    symbol/params. `base.css` colours each with `var(--tok-X, inherit)`, so **palette = the custom properties `--tok-k
    … --tok-v` in the skin's `@light`/`@dark`**. Decision: the markup always carries tokens; a skin styles them as its
    reference shows. macOS sets them all to `currentColor` (TextEdit shows plain text); a colourful docs palette is one
    edit away (the values are in the comment at the top of `mac-editor.css`). GNOME Text Editor highlights HTML itself, so
    Linux sets real colours; Notepad has none, so Windows sets `currentColor`.
  - **Chrome budget:** 2 of 8 nodes (`.pane-bar`, `.pane-head`), both `aria-hidden`, identical for every OS and for both
    views. Everything else is pseudo-elements: `.pane::before/::after`, `.pane-bar::before/::after`, `.pane-head::…`.
    Scroller: the body gets `tabindex="0"` and the title as `aria-label` when it can scroll: an explicit `height`, more
    than 22 lines (wrapped at an assumed 40 columns for text), or, for code, a line over 44 characters (a phone-width window
    scrolls long before 490px does). The build can't measure, so it over-approximates (an extra tab stop, never a missing
    one). Height: the window fits its text, capped at `--pane-max` (360px), or `--pane-h`.
  - **What a skin supplies** (`css/<os>-editor.css`, rooted at `.pane` like every skin; each rule needs `.pane-ed` (or
    `.pane[data-view=…]`) to beat the folder rules of `<os>.css`, as `mac-editor.css` does with `.pane.pane-ed …`):
    1. tokens in `@light`/`@dark`: the editor's text/background colours (`--bg` is the body's background and the gutter's),
       and the ten `--tok-*`; the window edge and shadow if they differ from the folder's (macOS: radius 16 instead of 26);
    2. the title bar on `.pane-bar` (height, the file name's font and colour, the window buttons, tab or proxy icon) and, if
       the OS has a second row (Notepad's menu bar), `.pane-head` (empty; it is `display:none` for a skin that has no use
       for it, which the folder skin's `.pane-head` rules would otherwise style); the folder skin's `::before/::after` on
       `.pane` and `.pane-bar` (macOS traffic lights, navigation pill) must be overridden or hidden, and status bars are
       `.pane::after` etc.; `.pane-bare`: no bar, no head, no buttons (hide `.pane::before`);
    3. `.pane-body`: font (monospace stack, size, line height), `padding`, colour (`padding-left:0` on code if the gutter is
       on, since the sticky gutter sits at the scrollport edge), scrollbars (`::-webkit-scrollbar` as the folder skins do;
       Firefox gets `scrollbar-width`/`scrollbar-color`);
    4. optionally the gutter (above) and a `@container` ladder in the order of §6 (drop decorative chrome below 440px);
    5. forced-colors and reduced-motion come from `base.css`; add no animation, and draw no caret or selection.
  - **macOS (TextEdit, plain text)** measures to the 2x captures: window 490x360, radius 16 (the folder window's 26 has a
    toolbar), a 32px bar (31px + a 1px `--ed-line` hairline; traffic lights at x=9, 23px apart; the proxy icon is
    `icons/mac/text.svg` at x=84, the name is 13.5px 600 SF, then a chevron), text at 11px/13px Menlo, 10px side padding,
    #000 on #fff and #fff on #1e1e1e. The dark window adds a 1px lighter top edge. The blue caret and the red
    spell-check squiggle in the captures are runner artifacts and are not drawn (they are masked in the QA cases,
    `kind:"artifact"`, so `tests/masks.js` does not treat them as text). The two code captures have a deeper window
    shadow than the text and folder captures, which the CSS cannot match for both, so their `shadowError` is looser.
  - **QA:** `qa/pane-adapter.js` renders `text`/`code` for macOS from `screenshots/fixture-assets/` (the files the capture
    typed); other OSes fall through to fixtures/null. `defaultRegions` gives the editors a 32px chrome region, and
    `compare.js` joins text rows across a 1px gap only for them (their lines are packed). `qa/lib/audit.js` has editor
    samples (prose, code, long, bare, fixed, empty) for every skin, `qa/backdrop.js` covers the editor cases.
  - **`lib/css.js` fix:** the token blocks of a skin's several files are now joined with `;` (a block's last declaration
    need not end with one, and `mac.css`'s didn't: the first token of the next file was swallowed).
  - **Colourful code where the OS is plain:** `highlight:true` (or `data-highlight="true"`, or `transform($, {highlight:true})`
    for the whole build) adds `pane-hl` to a highlighted code window; `mac-editor.css` then sets an Xcode-like `--tok-*`
    palette (light and dark). Off by default: TextEdit shows plain text.

### Browser windows (`pane.browser`), macOS and Linux built; the contract for the Windows skin

`pane.browser({ url, html | src, title, tint, sandbox, os, theme, width, height })` (`lib/browser.js`, skin
`css/mac-browser.css`, structure in `css/base.css`). One DOM for all three OSes, so the Windows (Edge) and Linux (GNOME Web)
skins are CSS only: `css/win-browser.css`, `css/linux-browser.css` (built). Until a skin exists, that OS's visitors get the macOS look
(`lib/css.js`: `browser` is in `VIEWS`, so a skin without `css/<os>-browser.css` is excluded from `.pane[data-view=browser]`
and the default skin takes them, exactly as with the icons view; an `os` pin for it is dropped with a warning).

```html
<figure class="pane pane-br" data-view="browser" data-secure="true|false" [data-pin] [data-theme]
        aria-label="Example Domain" [style="--pane-w:…;--pane-h:…;--br-tint:…"]>
  <div class="pane-bar" aria-hidden="true"><span class="pane-tab">Example Domain</span></div>   <!-- first chrome row -->
  <div class="pane-head" aria-hidden="true"></div>                                                <!-- second chrome row, empty -->
  <span class="pane-url" aria-hidden="true">                                                      <!-- the address field -->
    <span class="pane-u-s">https://</span><span class="pane-u-w">www.</span><span class="pane-u-h">example.com</span><span class="pane-u-p pane-u-r">/</span>
  </span>
  <div class="pane-page"><iframe class="pane-frame" title="Example Domain, page" sandbox="…" srcdoc="…"|src="…" loading="lazy"></iframe></div>
</figure>
```

- **Options.** `url` is what the field shows (never fetched; a bare host gets `https://`; defaults to `src`); `html` the static
  page, `src` the live one (both: html wins, with a warning); `title` the tab title and the accessible name (default the host);
  `tint` the page's top colour, which Safari's toolbar takes on in the light theme (default white); `sandbox` overrides a live
  frame's sandbox; `os`, `theme`, `width`, `height` as for the other windows (default size is the skin's: macOS 600x400).
  Never throws: bad input is shown as typed or dropped with a warning. `transform` turns
  `<pre class="browser" data-url title [data-src] [data-tint] [data-width] [data-height] [data-os] [data-theme]>` into one, the
  page being the pre's text (its `code` child's, if any), as the editor windows take their text; `data-src` wins over the text.
- **The page** is an iframe, not inlined markup: a static page is a `srcdoc` document, so the docs' own `h1`/`p`/`a`/`pre` CSS
  cannot reach it, `vw`/`vh` units refer to the window, and it scrolls inside the window. Static pages are sandboxed with
  `allow-popups allow-popups-to-escape-sandbox` only (no scripts) and get `<base target="_blank">`, so a click opens a new tab
  instead of replacing the mock page. A live `src` is `loading="lazy"`, `referrerpolicy="no-referrer"` and sandboxed with
  `allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox`; never `allow-same-origin` (a page on the docs'
  own origin could otherwise lift the sandbox). `src` must be http(s) or relative; anything else is dropped. The frame's `title`
  is "<title>, page"; the figure's `aria-label` is the title; chrome (`bar`, `head`, `url`) is `aria-hidden`.
- **The address is split** so each skin shows its own form: `.pane-u-s` scheme, `.pane-u-w` a leading `www.`, `.pane-u-h`
  host (and port; a subdomain is wrapped in `.pane-u-b` inside it, "preview-of-cv-on-clara." in preview-of-cv-on-clara.blot.im, by a
  rough rule rather than the public suffix list), `.pane-u-p` path+query+hash, with `.pane-u-r` on the path when it is only `/`. Safari shows the host alone
  (`.pane-u-s`, `.pane-u-w`, `.pane-u-p` hidden), Edge `https://example.com` (hide `.pane-u-r`), GNOME Web
  `https://example.com/` with the scheme dimmed. `data-secure` is `true` for https: a skin draws its padlock (or "Not secure")
  from it. An address that is not http(s) is one `.pane-u-h` holding the text.
- **Chrome budget.** Three nodes (`.pane-bar`, `.pane-head`, `.pane-url`), everything else pseudo-elements: `.pane::before/::after`,
  `.pane-bar::…`, `.pane-head::…`, `.pane-url::…`. `.pane-tab` is `display:none` in `base.css`; the Windows skin shows it as the
  tab's title. A skin places `.pane-url` itself (it is `position:absolute` in `base.css`; size and offsets are the skin's) and
  chooses whether `.pane-head` is a second row in the flow (Edge's toolbar under the tab strip) or an absolutely placed pill
  (Safari's tool buttons). `.pane-page` is the flexible remainder (`flex:1`), white by default; a skin may inset or round it
  (Edge's page has a rounded border). The skin sets the default size with `.pane.pane-br{--pane-w:…;--pane-h:…}` (an inline
  `style` wins) and the folder skin's `.pane::before`, `.pane-bar` and `.pane-head` rules must be overridden, as for the editors.
- **macOS (Safari, Tahoe, compact layout)** measures to the 2x capture: window 600x400, radius 26 and the folder window's
  shadow, a 52px toolbar row; the lights and the back/forward pill are the folder window's (`mac.css`: `.pane::before`,
  `.pane-bar::before/::after`); the address field is a 36px pill at x=185 (`.pane-url`; its `::before` is the reader/page-menu
  icon, `::after` reload, the padlock is `.pane-u-h::before`), the glyph pill is `.pane-head` at right:10px, 108.5px wide, one
  mask (`icons/mac/br-tools.svg`: New Tab, Share, Tab Overview, in the study's order). Pill fill, ring and shadow are the folder
  window's tokens (`--pill`, `--pill-ring`, `--pill-sh`). Light: the toolbar is transparent over the page, so `.pane`'s
  background is `--br-tint`; dark: solid `#1e1e1e`, and the page sits above the pills' shadow. Below 560px the glyph pill goes,
  below 440px the back/forward pill goes (`mac.css`) and the field takes the row.
- **Linux (GNOME Web, Epiphany 46, libadwaita)** measures to the 2x capture (`css/linux-browser.css`): window 720x400 with the
  folder window's frame (border, 3px ring, 1px inner line, 12px radius, no shadow: the capture has no compositor), one 46px header
  bar. GNOME Web shows no tab strip with one tab, so `.pane-tab` stays hidden. The bar draws its glyphs as two mask sprites
  (`icons/linux/br-l.svg` back, forward, reload, new tab, left-anchored; `br-r.svg` apps, library, main menu and the window
  buttons, right-anchored) over the three window-button discs (as in the folder skin); back and forward are `--off`. The address
  field is `.pane-url`, 224x34, radius 6, centred between the two glyph groups; its padlock (from `data-secure`) and bookmark star
  are background images (`br-lock-*`, `br-star-*`, one per theme: coloured files, because a mask would be clipped with the text),
  and the text is clipped 32px from the right by a transparent border, with no ellipsis, as the capture is. The scheme, `www.` and
  the path and the subdomain (`.pane-u-b`) are dim (50%), the rest of the host is not: GNOME Web dims every part but the
  registered domain, so the capture's visible text, all subdomain, is dim. Under 620px the apps and library buttons go, under 440px the
  forward, reload, new tab and main menu buttons too (GNOME Web itself moves its toolbar to the bottom below 600px). The capture
  (`screenshots/linux.sh`) loads the study's page over HTTPS from `browser-server.py` at `https://preview-of-cv-on-clara.blot.im/`
  (an `/etc/hosts` entry; a self-signed CA:TRUE certificate added with `update-ca-certificates`, which GNOME Web's TLS backend, GnuTLS,
  reads), so the field shows the padlock.
- **QA.** Cases `macos-{light,dark}-browser` (region `titlebar` is the top 52px), `linux-{light,dark}-browser` (GNOME Web) and, for the
  next skin, `windows-{light,dark}-browser` (Edge), informational in `qa/thresholds.json` until the skin exists (drop the flag and
  tighten with the skin). `qa/pane-adapter.js` renders every OS's case with the
  capture's page (`screenshots/fixture-assets/browser-page`, images inlined) at the reference's window size. The macOS capture
  loads that page, the study's, from a local HTTPS server as `https://preview-of-cv-on-clara.blot.im/` (`screenshots/macos.sh`,
  `screenshots/linux.sh`); the Windows reference is still on example.com until its capture script follows. `qa/lib/audit.js` has browser
  samples (static, live, long address, empty) for every skin.
