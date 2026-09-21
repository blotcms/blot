// folder() -> the window's HTML. See DESIGN.md for the DOM contract.

const parse = require("./parse");
const { formatDate, formatSize, formatFolderSize, formatType, splitExtension, kindOf, inventDates, inventSize, resolveAge } = require("./format");
const { OS_KEYS } = require("./os");
const css = require("./css");

// The OSes whose skin shows a Type cell; the cell is only emitted for them (GNOME's
// default columns have none, and macOS hides Kind).
const TYPE_OS = ["win"];

const escape = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// The text for each OS, one <span data-os> each (or just the pinned OS's).
const perOs = (fn, pin, oses = OS_KEYS) => (pin ? [pin] : oses).map((os) => `<span data-os="${os}">${escape(fn(os))}</span>`).join("");

// Rows that can exceed the window's height cap make the list a scroller, which must be
// keyboard reachable.
const SCROLLS_AFTER = 11;

function folder(tree, options = {}) {
  // A pin only holds for an OS whose skin is built; otherwise the window is unpinned and
  // follows the visitor (or the default skin), as if the author had not pinned it.
  const pin = OS_KEYS.includes(options.os) && css.SKINS.includes(options.os) ? options.os : null;
  if (options.os && !pin) console.warn(`pane: ignoring os pin "${String(options.os)}" (no skin built for it); the window follows the visitor`);
  const theme = ["light", "dark"].includes(options.theme) ? options.theme : null;
  const title = options.title || "Folder";
  const files = options.files || {};
  const now = options.now || "2026-01-01T00:00:00";
  const nodes = parse(tree);
  const total = (ns) => ns.reduce((n, x) => n + 1 + total(x.children), 0);
  const paths = (ns) => ns.flatMap((x) => [x.path, ...paths(x.children)]);
  const invented = inventDates(paths(nodes), now);
  let row = 0; // visible row index, for the stripes

  const cells = (node) => {
    const meta = files[node.name] || { bytes: inventSize(node.path), modified: invented[node.path] };
    const [given, written] = node.cols;
    // a written date is either an age ("3d", "yesterday"), formatted per OS relative to now, or shown as written
    const age = written ? resolveAge(written, now) : null;
    const size = (os) => (given ? given : node.folder ? formatFolderSize(node.children.length, os) : formatSize(meta.bytes, os));
    const date = (os) => (age ? formatDate(age, os, now) : written ? written : formatDate(meta.modified, os, now));
    const type = (os) => formatType(node.name, node.folder, os);
    // Type is emitted only where a skin can show it (not for a window pinned to macOS)
    const typeCell = !pin || TYPE_OS.includes(pin) ? `<span class="pane-cell pane-t">${perOs(type, pin, TYPE_OS)}</span>` : "";
    return `<span class="pane-cell pane-d">${perOs(date, pin)}</span><span class="pane-cell pane-s">${perOs(size, pin)}</span>${typeCell}`;
  };

  // Explorer hides the extension of known types. One string either way: a window pinned to
  // Windows drops it, one pinned to another OS keeps it, and a following window wraps it in
  // .pane-x, which the Windows skin hides.
  const label = (n) => {
    const split = pin === null || pin === "win" ? splitExtension(n.name) : null;
    if (!split) return escape(n.name);
    return pin ? escape(split[0]) : `${escape(split[0])}<span class="pane-x">${escape(split[1])}</span>`;
  };

  const list = (items, attrs) =>
    `<ul${attrs} role="list">` +
    items
      .map((n) => {
        const odd = row++ % 2 ? " pane-odd" : "";
        const open = n.children.length ? " pane-open" : "";
        const sr = n.folder ? `<span class="pane-sr">, folder${n.children.length ? ", expanded" : ""}</span>` : "";
        return (
          `<li><span class="pane-row${odd}${open}"><span class="pane-label"><i class="pane-icon pane-k-${kindOf(n)}"></i>${label(n)}${sr}</span>${cells(n)}</span>` +
          (n.children.length ? list(n.children, "") : "") +
          "</li>"
        );
      })
      .join("") +
    "</ul>";

  // A scroller must be keyboard reachable and named. With an explicit height we can't know
  // whether the rows fit, so it always is. The Windows list is always wider than its window
  // (the Size column runs off the edge, as in Explorer), so any window a Windows skin can
  // apply to is a scroller too. (Costs macOS and Linux visitors one extra tab stop.)
  const winList = (pin === null || pin === "win") && css.SKINS.includes("win");
  const scrolls = options.height || winList || total(nodes) > SCROLLS_AFTER;
  const body = list(nodes, ` class="pane-tree"${scrolls ? ` tabindex="0" aria-label="${escape(title)}"` : ""}`);
  const size = [options.width && `--pane-w:${escape(options.width)}`, options.height && `--pane-h:${escape(options.height)}`].filter(Boolean).join(";");
  return (
    `<figure class="pane" data-view="list"${pin ? ` data-pin="${pin}"` : ""}${theme ? ` data-theme="${theme}"` : ""}${size ? ` style="${size}"` : ""} aria-label="${escape(title)}">` +
    `<div class="pane-bar" aria-hidden="true">${escape(title)}</div><div class="pane-head" aria-hidden="true"><i></i><i></i><i></i></div>` +
    body +
    "</figure>"
  );
}

module.exports = { folder, OS_KEYS };
