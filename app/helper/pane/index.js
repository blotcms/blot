// pane: renders docs blocks as mock OS windows (macOS, Windows 11, GNOME Files).
// Built: folder windows in list view (macOS, Windows, GNOME), the icons view (macOS; the other skins fall
// back to it, DESIGN.md) and the editor windows (macOS; the other skins fall back to it). Skins are switched by <html data-os>, light/dark by
// prefers-color-scheme. See DESIGN.md (how) and PLAN.md (what).
//
// API
//   pane.folder(tree, opts) -> { html } | null     markup for one folder window
//   pane.text(text, opts)   -> { html }            text editor window (macOS built)
//   pane.code(code, opts)   -> { html }            code editor window: highlighted, no wrapping (macOS built)
//   pane.assets()           -> { css, js }         once per page (static, cacheable)
//   pane.transform($, { now })                     cheerio: replaces pre.folder|text|code
//   pane.isoNow()                                  "now" in the form `now` takes (UTC)
//
// Markup and assets are separate on purpose: a page with 20 windows has one stylesheet
// and one head snippet, not 20. A method returns null for something it doesn't
// implement yet (so a caller can fall back); it never throws for author input.
//
// `tree` is an indented tree, two spaces per level. A row is a folder when it ends in
// "/", has children, or has no "." in its name (the docs' existing convention, so an
// empty folder like "Posts" works). Options:
//   title    accessible name and title bar text
//   view     "list" (default) or "icons" (the top-level items only, as a grid): the two views every OS has. The captured
//            references have more (columns, gallery, tiles, content, sidebar); they are
//            OS-specific studies, not something an author can ask for.
//   files    name -> { bytes, modified: "YYYY-MM-DDTHH:MM:SS", folder? } for the columns
//   now      "today" as "YYYY-MM-DDTHH:MM:SS" (UTC). Rows without a date get recent ones (a couple
//            today and yesterday, a few this week, the rest up to about 18 months back, never
//            later than `now`), and a date written as an age in the source ("3d", "2h", "1w",
//            "6mo", "1y", "today", "yesterday") is resolved against it. Output never reads the
//            clock: without `now` it is a constant, so tests and the QA harness are stable, and
//            the docs build passes pane.isoNow() once per build so the windows stay fresh.
//   os       "mac" | "win" | "linux": pin this window to one OS instead of the visitor's
//            (the copy around it may say "Finder"); only that OS's markup is emitted
//   theme    "light" | "dark": pin the colour scheme (default: prefers-color-scheme)
//   width, height   CSS lengths, set as --pane-w / --pane-h (default: the reference size)
//
// Editor windows (text, code) take the same title, os, theme, width, height, now, plus
//   title     the file name in the title bar and the window's accessible name ("Text"/"Code" if absent)
//   chrome    false: the text panel alone, without the title bar and traffic lights (default true)
//   language  code only: a highlight.js language name (default "html"); "text" or an unknown name
//             shows plain text (highlight.js is optional: without it the code is plain, with a warning)
//   highlight true: colour the syntax where the OS's own editor doesn't (macOS TextEdit is plain); class
//             pane-hl on the window, palette in the skin. transform() takes it as an option (one value per
//             build) or from data-highlight="true".
// Text is shown exactly as given (whitespace and line breaks kept, everything escaped, never
// interpreted). The text editor wraps long lines; the code editor scrolls sideways.
//
// Values that differ per OS ("6 bytes"/"2.7 kB", "Today 15:38"/"5:29 PM") are rendered
// once per OS and shown by the same data-os CSS that skins the window.

const { folder: renderFolder, OS_KEYS } = require("./lib/markup");
const { formatSize, formatDate, formatFolderSize, isoNow } = require("./lib/format");
const css = require("./lib/css");
const { expand } = require("./lib/names");
const { editor } = require("./lib/editor");
const { resolve: resolveLanguage } = require("./lib/highlight");

// what an author can ask for; the QA harness has more views (see the header)
const VIEWS = ["list", "icons"];
const SUPPORTED_VIEWS = ["list", "icons"];

function folder(tree, options = {}) {
  const view = options.view === "tree" ? "list" : options.view || "list"; // the list view is a tree
  if (!SUPPORTED_VIEWS.includes(view)) return null;
  return { html: renderFolder(tree, options) };
}

// Editor windows (DESIGN.md "Editor windows"). `chrome: false` shows the text panel alone,
// without the title bar and traffic lights.
const text = (source, options = {}) => ({ html: editor("text", source, options) });
const code = (source, options = {}) => ({ html: editor("code", source, options) });

// Sets data-os unless the page already chose one (the QA harness does).
const JS =
  '(function(d){var e=d.documentElement;if(!e.dataset.os){var u=navigator.userAgent;e.dataset.os=/Android|Windows/.test(u)?"win":/Mac|iPhone|iPad/.test(u)?"mac":/Linux|X11/.test(u)?"linux":"mac"}})(document)';

let CSS;
const assets = () => ({ css: (CSS = CSS || css.build()), js: JS });

// For the docs build: replaces <pre class="folder|text|code"> in a cheerio document.
// (Assets are not injected here; the build ships assets() once.)
// Options: `now` ("YYYY-MM-DDTHH:MM:SS", UTC) is "today" for the invented dates and any dates
// written as ages ("3d"). The docs build passes one value per build (pane.isoNow()); without
// it the output is a constant, so it never depends on the clock by accident.
function transform($, options = {}) {
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
    const classes = ($(el).attr("class") || "").split(/\s+/).filter(Boolean);
    // the editors' old syntax: `with-chrome` shows a text window's title bar (a code window always had
    // its dots); data-chrome="true|false" says it outright
    const dataChrome = $(el).attr("data-chrome");
    const chrome = dataChrome ? dataChrome !== "false" : kind === "code" || classes.includes("with-chrome");
    const result = kinds[kind](source.text().replace(/^\n+|\s+$/g, ""), {
      now: options.now,
      title: ($(el).attr("title") || "").trim() || undefined,
      view: $(el).attr("data-view") || undefined,
      os: $(el).attr("data-os") || undefined,
      theme: $(el).attr("data-theme") || undefined,
      chrome,
      highlight: options.highlight || $(el).attr("data-highlight") === "true",
      // a class naming a language ("javascript") picks it; the default is html, as the old renderer had
      language: $(el).attr("data-language") || classes.find((c) => c !== "code" && resolveLanguage(c) && resolveLanguage(c) !== "plain") || undefined,
      width: $(el).attr("data-width") || undefined,
      height: $(el).attr("data-height") || undefined,
    });
    if (result) $(el).replaceWith(result.html);
  });
}

module.exports = { folder, text, code, assets, transform, isoNow, formatSize, formatDate, formatFolderSize, VIEWS, SUPPORTED_VIEWS, OS_KEYS };
