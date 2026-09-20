// pane: renders a <pre>-style tree as a mock file-manager window.
// SKELETON: one folder window, three skins (mac, win, linux) switched by
// <html data-os>, light/dark by prefers-color-scheme. See PLAN.md.
//
//   pane.render(text, { title, view, files, now }) -> { html, css, js } | null
//
// `text` is an indented tree (two spaces per level, folders have children).
// `view` is one of VIEWS; render returns null for a view that isn't
// implemented yet (SUPPORTED_VIEWS), so callers can fall back. `files` maps a
// name to { bytes, modified: "YYYY-MM-DDTHH:MM:SS", folder? } for the list
// columns; `now` is "today" (constant, so output is stable between builds).
// html is one figure per window, css is one shared stylesheet, js is the tiny
// snippet for <head> that sets data-os. The caller ships all three.
//
// Values that differ per OS ("6 bytes"/"2.7 kB", "Today 15:38"/"5:29 PM") are
// rendered once per OS and shown by the same data-os CSS that skins the window.

const OS_KEYS = ["mac", "win", "linux"];
// list is the default list/details view with the tree expanded
const VIEWS = ["list", "icons", "columns", "gallery", "tiles", "content", "sidebar"];
const SUPPORTED_VIEWS = ["list"];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parseDate(iso) {
  const m = /^(\d+)-(\d+)-(\d+)T(\d+):(\d+)/.exec(iso);
  return { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5] };
}

const sameDay = (a, b) => a.y === b.y && a.mo === b.mo && a.d === b.d;
const two = (n) => String(n).padStart(2, "0");
const clock12 = (t) => `${t.h % 12 || 12}:${two(t.mi)} ${t.h < 12 ? "AM" : "PM"}`;

// Date column text as each OS shows it in its list view.
function formatDate(iso, os, nowIso) {
  const t = parseDate(iso);
  const today = sameDay(t, parseDate(nowIso));
  if (os === "mac") return today ? clock12(t) : `${t.mo}/${t.d}/${String(t.y).slice(2)}`;
  if (os === "win") return `${t.mo}/${t.d}/${t.y} ${clock12(t)}`;
  return today ? `Today ${t.h}:${two(t.mi)}` : `${t.d} ${MONTHS[t.mo - 1]} ${t.y}`;
}

// Size column text. Finder: 1000-based, whole KB. Explorer details: 1024-based,
// rounded up to whole KB. GNOME Files: 1000-based, one decimal ("2.7 kB").
function formatSize(bytes, os) {
  const bytesText = bytes === 1 ? "1 byte" : `${bytes} bytes`;
  if (os === "win") {
    if (bytes < 1024) return bytesText;
    return bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024).toLocaleString("en-US")} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
  }
  if (bytes < 1000) return bytesText;
  const kb = bytes / 1000;
  if (os === "linux") return kb < 1000 ? `${kb.toFixed(1)} kB` : `${(kb / 1000).toFixed(1)} MB`;
  return kb < 1000 ? `${Math.round(kb)} KB` : `${(kb / 1000).toFixed(1)} MB`;
}

// Folder size column: Finder "--", Explorer blank, GNOME Files "N items".
function formatFolderSize(items, os) {
  if (os === "mac") return "--";
  if (os === "win") return "";
  return items === 1 ? "1 item" : `${items} items`;
}

const perOs = (fn) => OS_KEYS.map((os) => `<span data-os="${os}">${escape(fn(os))}</span>`).join("");

const escape = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function parse(text) {
  const lines = text.split("\n").filter((l) => l.trim());
  return lines.map((line, i) => {
    const depth = (line.length - line.trimStart().length) / 2;
    const next = lines[i + 1];
    const nextDepth = next ? (next.length - next.trimStart().length) / 2 : 0;
    return { name: line.trim(), depth, folder: nextDepth > depth };
  });
}

function render(text, options = {}) {
  const view = options.view || "list";
  if (!SUPPORTED_VIEWS.includes(view)) return null;
  const title = options.title || "Folder";
  const files = options.files || {};
  const now = options.now || "2026-01-01T00:00:00";
  const nodes = parse(text);
  const rows = nodes
    .map((r, i) => {
      const file = files[r.name];
      let cells = "";
      if (file) {
        let items = 0;
        for (let j = i + 1; j < nodes.length && nodes[j].depth > r.depth; j++) if (nodes[j].depth === r.depth + 1) items++;
        cells =
          `<span class="pane-cell pane-date">${perOs((os) => formatDate(file.modified, os, now))}</span>` +
          `<span class="pane-cell pane-size">${perOs((os) => (r.folder ? formatFolderSize(items, os) : formatSize(file.bytes, os)))}</span>`;
      }
      return (
        `<li class="pane-row" style="--d:${r.depth}"><span class="pane-name"><i class="pane-icon ${r.folder ? "pane-folder" : "pane-file"}" aria-hidden="true"></i>` +
        `<span>${escape(r.name)}<span class="pane-sr">${r.folder ? ", folder" : ""}</span></span></span>${cells}</li>`
      );
    })
    .join("");
  const html =
    `<figure class="pane" data-view="${view}" aria-label="${escape(title)}">` +
    `<div class="pane-bar" aria-hidden="true"><i class="pane-dots"></i><b>${escape(title)}</b></div>` +
    `<ul class="pane-tree">${rows}</ul></figure>`;
  return { html, css: CSS, js: JS };
}

// Sets data-os unless the page already chose one (the QA harness does).
const JS =
  '(function(d){var e=d.documentElement;if(!e.dataset.os){var u=navigator.userAgent;e.dataset.os=/Android|Windows/.test(u)?"win":/Mac|iPhone|iPad/.test(u)?"mac":/Linux|X11/.test(u)?"linux":"mac"}})(document)';

const CSS = `
.pane{--bg:#fff;--fg:#262626;--dim:#8a8a8a;--bar:#f6f6f6;--line:#d8d8d8;--stripe:#f4f5f5;
margin:0;width:490px;height:360px;box-sizing:border-box;overflow:hidden;background:var(--bg);color:var(--fg);
font:13px/20px -apple-system,"SF Pro Text",system-ui,sans-serif;border-radius:26px;
box-shadow:0 0 0 .5px rgba(0,0,0,.25),0 18px 40px rgba(0,0,0,.35)}
@media (prefers-color-scheme:dark){.pane{--bg:#1e1e1e;--fg:#e8e8e8;--dim:#8e8e8e;--bar:#2a2a2a;--line:#3a3a3a;--stripe:#262626}}
.pane-bar{display:flex;align-items:center;gap:40px;height:52px;padding:0 18px;font-size:15px}
.pane-dots{width:14px;height:14px;border-radius:50%;background:#ff5f57;box-shadow:22px 0 #febc2e,44px 0 #28c840;margin-right:44px}
.pane-tree{list-style:none;margin:28px 0 0;padding:0}
.pane-row{display:flex;align-items:center;height:20px;padding-left:calc(47px + var(--d)*15px)}
.pane-row:nth-child(even){background:var(--stripe)}
.pane-icon{width:12px;height:14px;margin-right:8px;background:#d8d8d8;border-radius:2px}
.pane-folder{background:#5ab4ee}
.pane-name{display:flex;align-items:center;flex:1;min-width:0;white-space:nowrap}
.pane-cell{color:var(--dim);white-space:nowrap}
.pane-cell>[data-os]{display:none}
html[data-os=mac] .pane-cell>[data-os=mac],html[data-os=win] .pane-cell>[data-os=win],html[data-os=linux] .pane-cell>[data-os=linux]{display:inline}
.pane-date{width:70px;margin-right:52px}
.pane-size{width:76px;text-align:right;padding-right:70px}
.pane-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
html[data-os=win] .pane{--bg:#fff;--fg:#1b1b1b;--bar:#eee;font:14px/20px "Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;
width:504px;height:367px;border-radius:0;box-shadow:none}
html[data-os=win] .pane-bar{background:var(--bar);height:40px;gap:0}
html[data-os=win] .pane-dots{display:none}
html[data-os=win] .pane-tree{margin-top:96px}
html[data-os=win] .pane-row{height:28px;padding-left:calc(30px + var(--d)*16px)}
html[data-os=win] .pane-row:nth-child(even){background:none}
html[data-os=win] .pane-date{width:140px;margin-right:0}
html[data-os=win] .pane-size{display:none}
html[data-os=linux] .pane{font:14px/20px Cantarell,"Adwaita Sans",system-ui,sans-serif;width:490px;height:520px;border-radius:12px;box-shadow:none}
html[data-os=linux] .pane-dots{display:none}
html[data-os=linux] .pane-bar{height:48px;gap:0;background:var(--bar)}
html[data-os=linux] .pane-tree{margin-top:32px}
html[data-os=linux] .pane-row{height:52px;padding-left:calc(85px + var(--d)*20px)}
html[data-os=linux] .pane-row:nth-child(even){background:none}
html[data-os=linux] .pane-name{flex:none;width:190px}
html[data-os=linux] .pane-size{order:1;width:auto;padding:0;margin-right:24px;text-align:left;width:80px}
html[data-os=linux] .pane-date{order:2;margin:0;width:auto}
@media (prefers-color-scheme:dark){
html[data-os=win] .pane{--bg:#191919;--fg:#fff;--bar:#202020}
html[data-os=linux] .pane{--bg:#242424;--fg:#fff;--bar:#303030}}
`.replace(/\n(?=[.@}h])/g, "\n");

module.exports = { render, formatSize, formatDate, formatFolderSize, VIEWS, SUPPORTED_VIEWS, OS_KEYS };
