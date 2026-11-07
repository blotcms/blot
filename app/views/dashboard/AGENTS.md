# Dashboard views, CSS and client JS

Templates for the logged-in dashboard (`/sites`). The server side is in `app/dashboard` (see its AGENTS.md). General view rules are in `app/views/AGENTS.md`.

## What each page loads

Built by `app/documentation/build/css.js` and `js.js` into `app/views-built`:

- `dashboard.min.css`: everything a dashboard page needs, on its own. It starts with the files shared with the documentation pages (`DASHBOARD_SHARED_FILES` in `css.js`: `css/base.css`, buttons, inputs, icons, the header, footer and breadcrumbs partials, ...), then every `.css` under `app/views/dashboard/` except the template editor's.
- `template-editor.min.css`: CodeMirror, its theme, and the editor, presets and setting-control CSS (`isTemplateEditorFile` in `css.js`). Only template editor pages load it (`templateEditorCSS` in `app/dashboard/site/template/index.js`).
- `dashboard.min.js` (from `app/views/js/dashboard.js`): the dashboard's client JS. Dashboard pages do not load `documentation.min.js`.
- Middle truncation (`app/views/js/truncate.js`) is not in that bundle: the build inlines it at the end of each dashboard page (`partials/truncate-script.html`, from `app/documentation/build/js.js`), so the first paint already shows shortened text. Anything else that changes what the first paint shows belongs in an inline script too, not the deferred bundle: the sidebar width and saved column widths are read in `partials/head.html`, and the Sites list is sorted on the server from the `sites-sort` cookie.
- `template-editor.min.js` and `js/template-source-editor.min.js`: editor pages only.

Pages that lead to the editor (the site overview, the template list) prefetch the editor bundles with `<link rel="prefetch">`, so they are cached before the click. Use the same pattern for any other page-specific bundle.

`css/base.css` holds the rules from `css/blot.css` and `css/mobile.css` that dashboard pages use; both bundles include it. Rules that only the brochure and documentation use stay in `blot.css`.

## Consistency

The same thing always has the same name and the same look, everywhere it appears: page headings, column headers, buttons, links, breadcrumbs, `<title>`s, messages and help text. Anything that differs needs a reason. Before adding a label, find what the dashboard already calls that thing, and before adding a control, find the component that already does that job (below). When a term or component changes, change every place it appears.

Words the dashboard uses (what the user sees, not internal names):

- **Site**, not blog. Its **Title** (the setting, and the Sites list's first column) and its **Domain**.
- **Template**: the one in use is "live on your site". **Edit** is the link to change any value in a row (not "Change" or "Edit template"). In the summary card at the top of a site's folder, a row that opens in place (Title, Domain) ends in a grey chevron pointing down that turns when open, and a row that is a link to another page (Template) in one pointing right; screen readers still hear Edit.
- **Folder** is the site's files (the Folder page and the folder box). **Files** is the filter that shows them. **Sync** is the connection to Dropbox, Google Drive, iCloud, Git or a local folder, and its pages. The folder box's top row starts "Folder", then a pill naming the client as wide as there's room for (`folder/folder-source.html`), which opens the sync settings under the row; the filters and search are on its right.
- **Post**, not entry. The filters are **Posts**, **Pages**, **Drafts** and **Scheduled**. Columns are **Title**, **File**, **Date published**, **Date modified**, **Size**.
- **Settings** is the site's Settings section.
- A missing value in a table cell is `--` (a folder's size, a draft's publish date).
- A form's buttons are **Save changes** (or "Save" plus the thing: "Save title") and **Cancel**. Cancel stays on the page and puts the form back. A destructive step offers **Do not delete** beside the red button.

Not settled yet, so check with the maintainer before relying on them: one name for the sync pages ("Sync", "Folder settings", "Change sync method" and "Resync" all appear), Delete vs Remove for files and other things, and the template editor's own "Settings" tab, which shares a name with the site's Settings.

## CSS conventions

- Tokens: use the custom properties in `css/tokens.css` (spacing `--space-*`, type `--text-*` and `--weight-*`, colour roles such as `--secondary-text-color` and `--surface-muted-color`, `--radius-*`, `--shadow-*`) and the base palette in `app/views/css/base.css` (`--text-color`, `--border-color`, `--accent-color`, ...). Avoid raw pixel values and hex colours in new rules.
- Components: reuse the shared component classes before writing page-specific CSS. Each component file opens with a comment listing its classes.
  - Buttons: `css/buttons.css` (`.btn`, `.btn-primary`, `.btn-soft`, `.btn-danger`, `.btn-quiet`, `.btn-sm`, `.btn-row`; `.working` shows progress). Older markup (`.buttons` rows, `form.dashboard-form .button`, `.panel-link.edit-design` / `.visit-site`) is mapped onto these in the same file.
  - File drop zones: `css/file-drop.css` (`.file-drop`), used by imports, template uploads, favicon and image settings.
  - Menus: `css/menu.css` (the floating surface, items and "…" triggers shared by row menus, switchers and the font picker) with `app/views/js/row-menu.js` (`initRowMenu`: one menu per list, filled from the clicked row's `data-` attributes).
  - Tables: `css/data-table.css` with `app/views/js/data-table.js` (`.data-table`, `.data-table--zebra`; sortable `<th data-sort-key>` holding a `.data-table__sort` button; `data-table-sort="client"` sorts the rows in the page by each cell's `data-sort-value`, `"custom"` hands sorting to the page's script through `table.dataTableSort`; `data-table-resizable` adds column resizing, kept per `data-table-resize-key`). The sites list and the folder listing both use it.
  - Site block: `css/sidebar-site.css` with `partials/sidebar-site.html`, the site's title at the top of its sidebar, which opens the site switcher: the user's sites, then Sites, Create site and Account (on phones, in the navigation bar with the section's name). `app/dashboard/site/index.js` loads the site list for it on every page. `<details data-dismissable>` close on an outside click or Escape (`js/details-dismiss.js`).
  - Breadcrumbs and sync status: every page more than one level deep starts with `partials/dashboard-trail.html`, built from `res.locals.breadcrumbs` (a crumb's slug is relative to the one before, unless it starts with "/"). Site pages add the sync status on its right (`partials/global-sync.html`, `css/global-sync.css`): `app/dashboard/util/sync-summary.js` renders it from the status already loaded with the blog, and `js/global-sync.js` keeps it live, listening to the page's existing status stream or opening one only while a sync or rebuild is running.
  - Tabs: `css/tabs.css` (`.tabs`, `.tabs__list`, `.tabs__link` with `aria-current="page"` on the current one; `.page-header--tabs` above them). Each tab is its own server-rendered page; the Settings section (`site/settings/settings-tabs.html`, `settingsTabs` in `app/dashboard/site/index.js`) uses it.
  - Middle truncation: add `class="truncate"` to an element holding a single line of text, such as a file name. `app/views/js/truncate.js` keeps the start and end ("A long fi…name.md"), keeps the full text in a `title`, and re-fits it on resize and for rows added later.
- Browser support: no native CSS nesting, and no `:has()` or `color-mix()` without a fallback.
- Keep page CSS next to its view (`folder/folder.css`, `site/site-dashboard.css`) and limited to layout specific to that page.

## Client JS

- Render on the server; reach for JS only when it clearly helps.
- No inline `<script>` blocks in views: put code in `app/views/js/*.js` (or the template editor's bundle), require it from the entry file, and pass server values through `data-` attributes. Inline scripts are re-rendered and re-sent on every request and can't be cached.
- Each module checks for its elements and does nothing on pages without them, since one bundle serves every dashboard page.
