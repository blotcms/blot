// Per-OS text for the list columns. Pure and deterministic: nothing reads the clock.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parseDate(iso) {
  const m = /^(\d+)-(\d+)-(\d+)T(\d+):(\d+)/.exec(iso);
  return { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5] };
}

const two = (n) => String(n).padStart(2, "0");
const clock12 = (t) => `${t.h % 12 || 12}:${two(t.mi)} ${t.h < 12 ? "AM" : "PM"}`;
const dayNumber = (t) => Math.floor(Date.UTC(t.y, t.mo - 1, t.d) / 86400000);

// Date column text as each OS shows it in its list view (Finder and GNOME checked against
// captures with files dated today, yesterday and five days back). Calendar days back from
// `nowIso`: 0 is today, 1 yesterday; older dates are plain dates on every OS (Finder
// "9/16/26", GNOME "16 Sep 2026"; no weekday names). Explorer always shows the absolute date.
function formatDate(iso, os, nowIso) {
  const t = parseDate(iso);
  const back = dayNumber(parseDate(nowIso)) - dayNumber(t);
  if (os === "mac") return back === 0 ? clock12(t) : back === 1 ? "Yesterday" : `${t.mo}/${t.d}/${String(t.y).slice(2)}`;
  if (os === "win") return `${t.mo}/${t.d}/${t.y} ${clock12(t)}`;
  const clock = `${t.h}:${two(t.mi)}`;
  if (back === 0) return `Today ${clock}`;
  if (back === 1) return `Yesterday ${clock}`;
  return `${t.d} ${MONTHS[t.mo - 1]} ${t.y}`;
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
// kept ("Draft.md", "Blot.webloc": see reference/windows/windows-light@2x.png). The runner has
// no Word, so .doc/.docx are "DOC File"/"DOCX File" with the extension shown, as captured.
const EXTENSIONS = {
  txt: { kind: "text", win: "Text Document", hide: true, linux: "Text" },
  md: { kind: "md", win: "MD File", linux: "Markdown" },
  html: { kind: "html", win: "Microsoft Edge HTML Document", hide: true, linux: "HTML" },
  gif: { kind: "image", win: "GIF File", hide: true, linux: "Image" },
  png: { kind: "image", win: "PNG File", hide: true, linux: "Image" },
  jpg: { kind: "image", win: "JPG File", hide: true, linux: "Image" },
  jpeg: { kind: "image", win: "JPEG File", hide: true, linux: "Image" },
  webloc: { kind: "link", win: "WEBLOC File", linux: "Link" },
  doc: { kind: "doc", win: "DOC File", linux: "Document" },
  docx: { kind: "doc", win: "DOCX File", linux: "Document" },
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

const isoOf = (ms) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}T${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`;
};
const msOf = (iso) => {
  const t = parseDate(iso);
  return Date.UTC(t.y, t.mo - 1, t.d, t.h, t.mi);
};

// "Now" as this module writes it: UTC, "YYYY-MM-DDTHH:MM:SS". The docs build calls this once per
// build (never per page) and passes it down as the `now` option.
const isoNow = (date = new Date()) => isoOf(date.getTime());

// A date written in the source as an age ("3d", "2h", "1w", "6mo", "1y", "today", "yesterday")
// -> an ISO time that far before `now`, or null when the text isn't one. Absolute dates
// ("Mar 3, 2024") are not resolved: they are shown as written.
const UNIT_MINUTES = { m: 1, h: 60, d: 1440, w: 10080, mo: 43200, y: 525600 };
function resolveAge(text, now) {
  const s = String(text || "").trim().toLowerCase();
  const nowMs = msOf(now);
  const since = parseDate(now).h * 60 + parseDate(now).mi; // minutes since midnight
  if (s === "today") return isoOf(nowMs - Math.max(1, Math.min(180, Math.floor(since / 2))) * 60000);
  if (s === "yesterday") return isoOf(nowMs - (since + 12 * 60) * 60000); // yesterday at noon
  const m = /^(\d+)\s*(m|h|d|w|mo|y)$/.exec(s);
  return m ? isoOf(nowMs - Number(m[1]) * UNIT_MINUTES[m[2]] * 60000) : null;
}

// Modified times for the rows of one window that have none given. Recency-weighted so a window
// in the docs looks alive: the rows are ranked by a hash of their path (stable for a given
// folder), then the first ranks land today and yesterday, a few this week, some this month,
// and the rest up to about 18 months back. Never later than `now`; a pure function of the
// paths and `now`. Returns { path: ISO }.
const BANDS = [
  null, // today: computed from the time of day below
  null, // yesterday
  [3 * 1440, 4 * 1440],
  [5 * 1440, 6 * 1440],
  [9 * 1440, 16 * 1440],
  [17 * 1440, 28 * 1440],
  [35 * 1440, 75 * 1440],
  [80 * 1440, 120 * 1440],
  [130 * 1440, 200 * 1440],
];
const OLDEST = 540 * 1440; // about 18 months
function inventDates(paths, now) {
  const nowMs = msOf(now);
  const since = parseDate(now).h * 60 + parseDate(now).mi; // minutes since midnight: today and yesterday are calendar days
  const ranked = paths.map((p) => [p, hash(p)]).sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1));
  const out = {};
  ranked.forEach(([p, h], rank) => {
    let minutes;
    if (rank === 0) minutes = 1 + ((h >>> 8) % Math.max(1, Math.min(300, since - 1))); // earlier today
    else if (rank === 1) minutes = since + 60 + ((h >>> 8) % 1320); // yesterday, between 00:00 and 23:00
    else {
      const [lo, hi] = rank < BANDS.length ? BANDS[rank] : [200 * 1440, OLDEST];
      minutes = lo + ((h >>> 8) % (hi - lo + 1));
    }
    out[p] = isoOf(nowMs - Math.max(1, minutes) * 60000);
  });
  return out;
}

// Size for a file that has none given: a function of the path only.
function inventSize(path) {
  const h = hash(path);
  const ext = (/\.([^.]+)$/.exec(path) || [])[1];
  return Math.round(40 + (h % 1000) * ((SCALE[(ext || "").toLowerCase()] || 1000) / 500));
}

// Size and modified time for one file on its own (kept for callers with a single row).
function invent(path, now) {
  return { bytes: inventSize(path), modified: inventDates([path], now)[path] };
}

module.exports = { formatDate, formatSize, formatFolderSize, formatType, splitExtension, kindOf, EXTENSIONS, hash, invent, inventDates, inventSize, resolveAge, isoNow, parseDate };
