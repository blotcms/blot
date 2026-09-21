// text() and code() -> the editor window's HTML. See DESIGN.md "Editor windows" for the DOM contract.

const { highlight } = require("./highlight");
const { OS_KEYS } = require("./os");
const css = require("./css");

const escape = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// Content that may not fit the window's height cap (or, for code, its width) makes the body a
// scroller, which must be keyboard reachable. The build can't measure, so these are
// deliberately pessimistic: a phone-width window wraps and scrolls much earlier than 490px does.
const SCROLLS_AFTER = 22; // (visual) lines
const WRAP_AT = 40; // characters per line assumed for wrapped text
const WIDE_LINE = 44; // characters; a code line longer than this can scroll sideways in a narrow window

const DEFAULT_TITLE = { text: "Text", code: "Code" };

function editor(kind, source, options) {
  options = options || {};
  const pin = OS_KEYS.includes(options.os) && css.SKINS.includes(options.os) ? options.os : null;
  if (options.os && !pin) console.warn(`pane: ignoring os pin "${String(options.os)}" (no skin built for it); the window follows the visitor`);
  const theme = ["light", "dark"].includes(options.theme) ? options.theme : null;
  const chrome = options.chrome !== false;
  const raw = (source === null || source === undefined ? "" : String(source)).replace(/\r\n?/g, "\n");
  const title = String(options.title || "").trim();
  const name = title || DEFAULT_TITLE[kind];
  const lines = raw.split("\n");

  const wraps = (l) => Math.max(1, Math.ceil(l.length / WRAP_AT));
  const scrolls =
    Boolean(options.height) ||
    (kind === "code" ? lines.length > SCROLLS_AFTER || lines.some((l) => l.length > WIDE_LINE) : lines.reduce((n, l) => n + wraps(l), 0) > SCROLLS_AFTER);
  const attrs = `class="pane-body"${scrolls ? ` tabindex="0" aria-label="${escape(name)}"` : ""}`;

  let body;
  let language = null;
  if (kind === "code") {
    const result = highlight(raw, options.language);
    language = result.language;
    body = `<pre ${attrs}><code>${result.lines.map((l) => `<span class="pane-l">${l}</span>`).join("\n")}</code></pre>`;
  } else {
    // a newline right after <pre> is dropped by the HTML parser: keep a leading blank line
    body = `<pre ${attrs}>${raw.startsWith("\n") ? "\n" : ""}${escape(raw)}</pre>`;
  }

  const size = [options.width && `--pane-w:${escape(options.width)}`, options.height && `--pane-h:${escape(options.height)}`].filter(Boolean).join(";");
  const classes = `pane pane-ed${chrome ? "" : " pane-bare"}`;
  return (
    `<figure class="${classes}" data-view="${kind}"${language ? ` data-lang="${escape(language)}"` : ""}${pin ? ` data-pin="${pin}"` : ""}${theme ? ` data-theme="${theme}"` : ""}${size ? ` style="${size}"` : ""} aria-label="${escape(name)}">` +
    (chrome ? `<div class="pane-bar" aria-hidden="true">${title || kind === "text" ? escape(name) : ""}</div><div class="pane-head" aria-hidden="true"></div>` : "") +
    body +
    "</figure>"
  );
}

module.exports = { editor, DEFAULT_TITLE };
