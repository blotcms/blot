// folder() -> the window's HTML. See DESIGN.md for the DOM contract.

const parse = require("./parse");
const { formatDate, formatSize, formatFolderSize, invent } = require("./format");

const OS_KEYS = ["mac", "win", "linux"];

const escape = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// The text for each OS, one <span data-os> each (or just the pinned OS's).
const perOs = (fn, pin) => (pin ? [pin] : OS_KEYS).map((os) => `<span data-os="${os}">${escape(fn(os))}</span>`).join("");

// extension -> icon kind (one table for every OS; each skin draws the kinds it has)
const KINDS = { txt: "text", gif: "image", png: "image", jpg: "image", jpeg: "image", webloc: "link", md: "md", html: "html", doc: "doc", docx: "doc" };
const kindOf = (node) => (node.folder ? "folder" : KINDS[(/\.([^.]+)$/.exec(node.name) || [])[1]?.toLowerCase()] || "generic");

// Rows that can exceed the window's height cap make the list a scroller, which must be
// keyboard reachable.
const SCROLLS_AFTER = 11;

function folder(tree, options = {}) {
  const pin = OS_KEYS.includes(options.os) ? options.os : null;
  const theme = ["light", "dark"].includes(options.theme) ? options.theme : null;
  const title = options.title || "Folder";
  const files = options.files || {};
  const now = options.now || "2026-01-01T00:00:00";
  const nodes = parse(tree);
  const total = (ns) => ns.reduce((n, x) => n + 1 + total(x.children), 0);
  let row = 0; // visible row index, for the stripes

  const cells = (node) => {
    const meta = files[node.name] || invent(node.path, now);
    const [given, written] = node.cols;
    const size = (os) => (given ? given : node.folder ? formatFolderSize(node.children.length, os) : formatSize(meta.bytes, os));
    const date = (os) => (written ? written : formatDate(meta.modified, os, now));
    return `<span class="pane-cell pane-d">${perOs(date, pin)}</span><span class="pane-cell pane-s">${perOs(size, pin)}</span>`;
  };

  const list = (items, attrs) =>
    `<ul${attrs} role="list">` +
    items
      .map((n) => {
        const odd = row++ % 2 ? " pane-odd" : "";
        const open = n.children.length ? " pane-open" : "";
        const sr = n.folder ? `<span class="pane-sr">, folder${n.children.length ? ", expanded" : ""}</span>` : "";
        return (
          `<li><span class="pane-row${odd}${open}"><span class="pane-label"><i class="pane-icon pane-k-${kindOf(n)}"></i>${escape(n.name)}${sr}</span>${cells(n)}</span>` +
          (n.children.length ? list(n.children, "") : "") +
          "</li>"
        );
      })
      .join("") +
    "</ul>";

  const body = list(nodes, ` class="pane-tree"${total(nodes) > SCROLLS_AFTER ? ' tabindex="0"' : ""}`);
  const size = [options.width && `--pane-w:${escape(options.width)}`, options.height && `--pane-h:${escape(options.height)}`].filter(Boolean).join(";");
  return (
    `<figure class="pane" data-view="list"${pin ? ` data-pin="${pin}"` : ""}${theme ? ` data-theme="${theme}"` : ""}${size ? ` style="${size}"` : ""} aria-label="${escape(title)}">` +
    `<div class="pane-bar" aria-hidden="true">${escape(title)}</div><div class="pane-head" aria-hidden="true"><i></i><i></i><i></i></div>` +
    body +
    "</figure>"
  );
}

module.exports = { folder, OS_KEYS };
