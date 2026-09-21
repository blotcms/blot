// pane: renders docs blocks as mock OS windows (macOS, Windows 11, GNOME Files).
// Stage 1: the macOS folder window in list view is built; win and linux skins, the icons
// view and the editor windows are not. Skins are switched by <html data-os>, light/dark by
// prefers-color-scheme. See DESIGN.md (how) and PLAN.md (what).
//
// API
//   pane.folder(tree, opts) -> { html } | null     markup for one folder window
//   pane.text(text, opts)   -> { html } | null     text editor window (not built yet)
//   pane.code(code, opts)   -> { html } | null     code editor window (not built yet)
//   pane.assets()           -> { css, js }         once per page (static, cacheable)
//   pane.transform($)                              cheerio: replaces pre.folder|text|code
//
// Markup and assets are separate on purpose: a page with 20 windows has one stylesheet
// and one head snippet, not 20. A method returns null for something it doesn't
// implement yet (so a caller can fall back); it never throws for author input.
//
// `tree` is an indented tree, two spaces per level. A row is a folder when it ends in
// "/", has children, or has no "." in its name (the docs' existing convention, so an
// empty folder like "Posts" works). Options:
//   title    accessible name and title bar text
//   view     "list" (default) or "icons": the two views every OS has. The captured
//            references have more (columns, gallery, tiles, content, sidebar); they are
//            OS-specific studies, not something an author can ask for.
//   files    name -> { bytes, modified: "YYYY-MM-DDTHH:MM:SS", folder? } for the columns
//   now      "today" as "YYYY-MM-DDTHH:MM:SS". Output never depends on the real clock, so
//            builds are stable and cacheable. Defaults to a constant.
//   os       "mac" | "win" | "linux": pin this window to one OS instead of the visitor's
//            (the copy around it may say "Finder"); only that OS's markup is emitted
//   theme    "light" | "dark": pin the colour scheme (default: prefers-color-scheme)
//   width, height   CSS lengths, set as --pane-w / --pane-h (default: the reference size)
//
// Values that differ per OS ("6 bytes"/"2.7 kB", "Today 15:38"/"5:29 PM") are rendered
// once per OS and shown by the same data-os CSS that skins the window.

const { folder: renderFolder, OS_KEYS } = require("./lib/markup");
const { formatSize, formatDate, formatFolderSize } = require("./lib/format");
const css = require("./lib/css");
const { expand } = require("./lib/names");

// what an author can ask for; the QA harness has more views (see the header)
const VIEWS = ["list", "icons"];
const SUPPORTED_VIEWS = ["list"];

function folder(tree, options = {}) {
  const view = options.view === "tree" ? "list" : options.view || "list"; // the list view is a tree
  if (!SUPPORTED_VIEWS.includes(view)) return null;
  return { html: renderFolder(tree, options) };
}

// Editor windows are not built yet; null tells the caller to fall back.
const text = () => null;
const code = () => null;

// Sets data-os unless the page already chose one (the QA harness does).
const JS =
  '(function(d){var e=d.documentElement;if(!e.dataset.os){var u=navigator.userAgent;e.dataset.os=/Android|Windows/.test(u)?"win":/Mac|iPhone|iPad/.test(u)?"mac":/Linux|X11/.test(u)?"linux":"mac"}})(document)';

let CSS;
const assets = () => ({ css: (CSS = CSS || css.build()), js: JS });

// For the docs build: replaces <pre class="folder|text|code"> in a cheerio document.
// (Assets are not injected here; the build ships assets() once.)
function transform($) {
  $("span.pane-name").each((i, el) => {
    if ($(el).children().length) return; // already expanded
    const html = expand($(el).text(), $(el).attr("data-key"));
    if (html) $(el).removeAttr("data-key").html(html);
    else console.warn(`pane: unknown pane-name term "${$(el).text()}"`);
  });
  const kinds = { folder, text, code };
  $("pre.folder, pre.text, pre.code").each((i, el) => {
    const kind = ["folder", "text", "code"].find((k) => $(el).hasClass(k));
    const source = $(el).find("code").length ? $(el).find("code").first() : $(el);
    const result = kinds[kind](source.text().replace(/^\n+|\s+$/g, ""), {
      title: ($(el).attr("title") || "").trim() || undefined,
      view: $(el).attr("data-view") || undefined,
      os: $(el).attr("data-os") || undefined,
      theme: $(el).attr("data-theme") || undefined,
    });
    if (result) $(el).replaceWith(result.html);
  });
}

module.exports = { folder, text, code, assets, transform, formatSize, formatDate, formatFolderSize, VIEWS, SUPPORTED_VIEWS, OS_KEYS };
