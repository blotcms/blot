// folder() -> the window's HTML. See DESIGN.md for the DOM contract.

const parse = require("./parse");
const {
  formatDate,
  formatSize,
  formatFolderSize,
  formatType,
  splitExtension,
  kindOf,
  inventDates,
  inventSize,
  resolveAge,
} = require("./format");
const { OS_KEYS } = require("./os");
const css = require("./css");

// The OSes whose skin shows a Type cell; the cell is only emitted for them (GNOME's
// default columns have none, and macOS hides Kind).
const TYPE_OS = ["win"];

const escape = (s) =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]
  );

// A picture's address for a thumbnail: http(s), protocol-relative, root-relative or relative paths and
// image data URIs. Anything else (javascript:, other schemes) is dropped and the kind's icon is shown.
function safeUrl(u) {
  if (typeof u !== "string") return null;
  u = u.trim();
  if (/^data:image\/(png|jpe?g|gif|webp|avif);base64,[a-z0-9+/=]+$/i.test(u))
    return u;
  if (/^(https?:)?\/\//i.test(u)) return u;
  return /^[^:?#]*([?#]|$)/.test(u) && u ? u : null; // no scheme: root-relative or relative
}

// Finder shows a name over two lines and shortens a longer one in the middle ("longer-n...cated.jpg"),
// keeping the end, which carries the extension. CSS cannot truncate in the middle, so a name that
// surely overflows two lines of the 104px label is split into its start and its last few characters
// (DESIGN.md, "Icons view"). The width is an estimate of 12px SF Pro text, per character class.
const NARROW = /[iljtfI.,;:'|!()[\]\- ]/;
const WIDE = /[mwMW@%]/;
const estimate = (name) =>
  [...name].reduce(
    (w, c) =>
      w +
      (NARROW.test(c) ? 3.6 : WIDE.test(c) ? 10 : /[A-Z0-9]/.test(c) ? 8 : 6.4),
    0
  );
const TWO_LINES = 190;
function splitName(name) {
  if (estimate(name) <= TWO_LINES) return null;
  const ext = /\.[^.\s]{1,8}$/.exec(name);
  const tail = Math.min(name.length - 1, (ext ? ext[0].length : 3) + 5);
  return [name.slice(0, -tail), name.slice(-tail)];
}

// The text for each OS, one <span data-os> each (or just the pinned OS's).
const perOs = (fn, pin, oses = OS_KEYS) =>
  (pin ? [pin] : oses)
    .map((os) => `<span data-os="${os}">${escape(fn(os))}</span>`)
    .join("");

// Rows that can exceed the window's height cap make the list a scroller, which must be
// keyboard reachable.
const SCROLLS_AFTER = 11;
// The icons view is a grid whose row count depends on the container width, so it is a scroller
// whenever it holds more items than one row of the narrowest usual window (DESIGN.md, icons view).
const ICON_SCROLLS_AFTER = 4;

function folder(tree, options = {}) {
  // A pin only holds for an OS whose skin is built; otherwise the window is unpinned and
  // follows the visitor (or the default skin), as if the author had not pinned it.
  const view =
    options.view === "icons"
      ? "icons"
      : options.view === "desktop"
        ? "desktop"
        : "list";
  const pin =
    OS_KEYS.includes(options.os) &&
    css.SKINS.includes(options.os) &&
    css.viewsOf(options.os).includes(view)
      ? options.os
      : null;
  if (options.os && !pin)
    console.warn(
      `pane: ignoring os pin "${String(options.os)}" (no ${view} view built for it); the window follows the visitor`
    );
  const theme = ["light", "dark"].includes(options.theme)
    ? options.theme
    : null;
  const title = options.title || "Folder";
  const files = options.files || {};
  const now = options.now || "2026-01-01T00:00:00";
  const large = ["large", 128, "128"].includes(options.iconSize);
  const nodes = parse(tree);
  const total = (ns) => ns.reduce((n, x) => n + 1 + total(x.children), 0);
  const paths = (ns) => ns.flatMap((x) => [x.path, ...paths(x.children)]);
  const invented = inventDates(paths(nodes), now);
  let row = 0; // visible row index, for the stripes

  // a written date is either an age ("3d", "yesterday"), formatted per OS relative to now, or shown as written
  const dateOf = (node, os) => {
    const meta = files[node.name] || { modified: invented[node.path] };
    const [, written] = node.cols;
    const age = written ? resolveAge(written, now) : null;
    return age
      ? formatDate(age, os, now)
      : written
        ? written
        : formatDate(meta.modified, os, now);
  };
  const allNodes = (ns) => ns.flatMap((x) => [x, ...allNodes(x.children)]);
  // GNOME Files widens the Modified column to fit "Yesterday 11:35" and moves Size left; the
  // skin needs to know (class pane-yd), because CSS can't measure the column's widest text
  const widerDates =
    view === "list" &&
    (pin === null || pin === "linux") &&
    allNodes(nodes).some((n) => dateOf(n, "linux").startsWith("Yesterday"));

  const cells = (node) => {
    const meta = files[node.name] || { bytes: inventSize(node.path) };
    const given = node.cols[0];
    const size = (os) =>
      given
        ? given
        : node.folder
          ? formatFolderSize(node.children.length, os)
          : formatSize(meta.bytes, os);
    const date = (os) => dateOf(node, os);
    const type = (os) => formatType(node.name, node.folder, os);
    // Type is emitted only where a skin can show it (not for a window pinned to macOS)
    const typeCell =
      !pin || TYPE_OS.includes(pin)
        ? `<span class="pane-cell pane-t">${perOs(type, pin, TYPE_OS)}</span>`
        : "";
    return `<span class="pane-cell pane-d">${perOs(date, pin)}</span><span class="pane-cell pane-s">${perOs(size, pin)}</span>${typeCell}`;
  };

  // Explorer hides the extension of known types. One string either way: a window pinned to
  // Windows drops it, one pinned to another OS keeps it, and a following window wraps it in
  // .pane-x, which the Windows skin hides.
  const label = (n) => {
    const split = pin === null || pin === "win" ? splitExtension(n.name) : null;
    if (!split) return escape(n.name);
    return pin
      ? escape(split[0])
      : `${escape(split[0])}<span class="pane-x">${escape(split[1])}</span>`;
  };

  const list = (items, attrs) =>
    `<ul${attrs} role="list">` +
    items
      .map((n) => {
        const odd = row++ % 2 ? " pane-odd" : "";
        const open = n.children.length ? " pane-open" : "";
        const sel = n.attrs.selected ? " pane-sel" : "";
        const sr =
          (n.folder
            ? `<span class="pane-sr">, folder${n.children.length ? ", expanded" : ""}</span>`
            : "") +
          (n.attrs.selected ? '<span class="pane-sr">, selected</span>' : "");
        return (
          `<li><span class="pane-row${odd}${open}${sel}"><span class="pane-label"><i class="pane-icon pane-k-${kindOf(n)}"></i>${label(n)}${sr}</span>${cells(n)}</span>` +
          (n.children.length ? list(n.children, "") : "") +
          "</li>"
        );
      })
      .join("") +
    "</ul>";

  // Icons view: the top-level items only, as a flat list (a folder can't expand in place). One
  // li per item: the icon and the label. A generic file carries its extension for the icon's
  // caption (macOS prints it on the page); the label is the same string as in the list view.
  const items = () =>
    `<ul class="pane-tree" role="list"${scrollsIcons ? ` tabindex="0" aria-label="${escape(title)}"` : ""}>` +
    nodes
      .map((n) => {
        const kind = kindOf(n);
        const ext =
          kind === "generic" && !n.folder && /\.([^.]+)$/.test(n.name)
            ? ` data-ext="${escape(/\.([^.]+)$/.exec(n.name)[1].toUpperCase())}"`
            : "";
        const sr =
          (n.folder ? '<span class="pane-sr">, folder</span>' : "") +
          (n.attrs.selected ? '<span class="pane-sr">, selected</span>' : "");
        // [img=URL]: the picture itself is the icon (an <img> inside it, the one node a thumbnail adds)
        const url = safeUrl(n.attrs.img);
        const picture = url
          ? `<img src="${escape(url)}" alt="" loading="lazy" decoding="async">`
          : "";
        const split = splitName(n.name);
        const text = split
          ? `<span class="pane-m" style="--n:${split[1].length}">${escape(split[0])}</span><span class="pane-e">${escape(split[1])}</span>`
          : label(n);
        return `<li${n.attrs.selected ? ' class="pane-sel"' : ""}><i class="pane-icon pane-k-${kind}${url ? " pane-th" : ""}"${ext}>${picture}</i><span class="pane-label">${text}${sr}</span></li>`;
      })
      .join("") +
    "</ul>";
  // (large icons hold two to a row in the default window, so a second row can already scroll)
  const scrollsIcons =
    options.height || nodes.length > (large ? 2 : ICON_SCROLLS_AFTER);

  // A scroller must be keyboard reachable and named. With an explicit height we can't know
  // whether the rows fit, so it always is. The Windows list is always wider than its window
  // (the Size column runs off the edge, as in Explorer), so any window a Windows skin can
  // apply to is a scroller too. (Costs macOS and Linux visitors one extra tab stop.)
  const winList = (pin === null || pin === "win") && css.SKINS.includes("win");
  const scrolls = options.height || winList || total(nodes) > SCROLLS_AFTER;
  const body =
    view === "list"
      ? list(
          nodes,
          ` class="pane-tree"${scrolls ? ` tabindex="0" aria-label="${escape(title)}"` : ""}`
        )
      : items();
  const size = [
    options.width && `--pane-w:${escape(options.width)}`,
    options.height && `--pane-h:${escape(options.height)}`,
  ]
    .filter(Boolean)
    .join(";");
  // Desktop icons sit loose on the wallpaper (DESIGN.md, "Desktop view"): no title bar, no
  // traffic lights, no window box at all, just the icon grid.
  const chrome =
    view !== "desktop"
      ? `<div class="pane-bar" aria-hidden="true">${escape(title)}</div><div class="pane-head" aria-hidden="true"><i></i><i></i><i></i></div>`
      : "";
  return (
    `<figure class="pane${widerDates ? " pane-yd" : ""}${large && view !== "list" ? " pane-lg" : ""}${options.toolbar === "view" && view === "icons" ? " pane-vb" : ""}" data-view="${view}"${pin ? ` data-pin="${pin}"` : ""}${theme ? ` data-theme="${theme}"` : ""}${size ? ` style="${size}"` : ""} aria-label="${escape(title)}">` +
    chrome +
    body +
    "</figure>"
  );
}

module.exports = { folder, OS_KEYS };
