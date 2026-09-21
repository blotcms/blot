// Per-OS text for the list columns. Pure and deterministic: nothing reads the clock.

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

// One row per extension: the icon kind (shared by every OS), Explorer's Type text and
// whether Explorer hides the extension (only for types Windows has a handler for), and
// GNOME's Type text. Types Windows doesn't know show as "<EXT> File" with the extension
// kept ("Draft.md", "Blot.webloc": see reference/windows/windows-light@2x.png).
const EXTENSIONS = {
  txt: { kind: "text", win: "Text Document", hide: true, linux: "Text" },
  md: { kind: "md", win: "MD File", linux: "Markdown" },
  html: { kind: "html", win: "Microsoft Edge HTML Document", hide: true, linux: "HTML" },
  gif: { kind: "image", win: "GIF File", hide: true, linux: "Image" },
  png: { kind: "image", win: "PNG File", hide: true, linux: "Image" },
  jpg: { kind: "image", win: "JPG File", hide: true, linux: "Image" },
  jpeg: { kind: "image", win: "JPEG File", hide: true, linux: "Image" },
  webloc: { kind: "link", win: "WEBLOC File", linux: "Link" },
  doc: { kind: "doc", win: "Microsoft Word 97 - 2003 Document", hide: true, linux: "Document" },
  docx: { kind: "doc", win: "Microsoft Word Document", hide: true, linux: "Document" },
  pdf: { win: "Microsoft Edge PDF Document", hide: true, linux: "PDF Document" },
  css: { win: "CSS File", linux: "CSS" },
  js: { win: "JavaScript File", linux: "JavaScript" },
  json: { win: "JSON File", linux: "JSON" },
};

const extOf = (name) => (/\.([^.]+)$/.exec(name) || [])[1] || "";
const known = (name) => Object.prototype.hasOwnProperty.call(EXTENSIONS, extOf(name).toLowerCase()) && EXTENSIONS[extOf(name).toLowerCase()];

const kindOf = (node) => (node.folder ? "folder" : (known(node.name) && known(node.name).kind) || "generic");

// Type (Kind) column text. macOS has no Type column in the list view (Kind is hidden).
function formatType(name, isFolder, os) {
  if (os === "mac") return "";
  const e = !isFolder && known(name);
  if (os === "win") return isFolder ? "File folder" : e ? e.win : extOf(name) ? `${extOf(name).toUpperCase()} File` : "File";
  return isFolder ? "Folder" : e ? e.linux : "Unknown";
}

// Splits a file name into [shown on Windows, the extension Explorer hides] or null when
// Explorer shows the whole name.
function splitExtension(name) {
  const e = known(name);
  const m = e && e.hide && /^(.+?)(\.[^.]+)$/.exec(name);
  return m ? [m[1], m[2]] : null;
}

// FNV-1a: a stable 32-bit hash, used to invent missing sizes and dates.
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

const SCALE = { md: 900, txt: 300, html: 1400, css: 900, js: 1800, json: 500, png: 6000, jpg: 24000, gif: 4000, pdf: 60000, doc: 12000, docx: 12000 };

// Size and modified time for a file that has none given: a function of the path and
// the (constant) now, never of the clock. Dates fall 1 to 900 days back.
function invent(path, now) {
  const h = hash(path);
  const ext = (/\.([^.]+)$/.exec(path) || [])[1];
  const bytes = 40 + (h % 1000) * ((SCALE[(ext || "").toLowerCase()] || 1000) / 500);
  const t = parseDate(now);
  const days = 1 + ((h >>> 10) % 900);
  const d = new Date(Date.UTC(t.y, t.mo - 1, t.d - days, 9 + ((h >>> 20) % 9), (h >>> 4) % 60));
  const iso = `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}T${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:00`;
  return { bytes: Math.round(bytes), modified: iso };
}

module.exports = { formatDate, formatSize, formatFolderSize, formatType, splitExtension, kindOf, EXTENSIONS, hash, invent, parseDate };
