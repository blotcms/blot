// The short sync status shown at the top right of every site page
// (partials/global-sync.html, js/global-sync.js keeps it live). One of:
//   synced    "Synced 3 min ago"
//   syncing   "Syncing Imagination.md", or with progress "Rebuilding" and
//             "3 of 120" ("Applying settings" for settings rebuilds)
//   error     a client health issue's label, or "Sync failed"
//   off       "No folder connected"
// js/global-sync.js formats live messages the same way; keep the two in step.

const PROGRESS = /^\((\d+)\/(\d+)\)\s*(.*)$/;

function ago(when, now = Date.now()) {
  const minutes = Math.floor((now - when) / 60000);
  if (!(minutes >= 1)) return "just now";
  if (minutes < 60) return minutes + " min ago";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + " hr ago";
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day ago" : days + " days ago";
}

const number = (n) => Number(n).toLocaleString("en-US");

// "Syncing /Essays/Imagination.md" -> "Syncing Imagination.md"
function shorten(text) {
  return text
    .replace(/^(\w+) \/.*\/([^/]+)$/, "$1 $2")
    .replace(/^(\w+) \/([^/]+)$/, "$1 $2");
}

module.exports = function syncSummary(blog) {
  if (!blog.client) return { state: "off", label: "No folder connected" };

  if (blog.healthIssue) {
    return { state: "error", label: blog.healthIssue.label || "Sync failed" };
  }

  const message = (blog.status && blog.status.message) || "Synced";

  if (message === "Synced") {
    return {
      state: "synced",
      label: "Synced " + ago(blog.status && blog.status.datestamp),
    };
  }

  if (/^error/i.test(message)) return { state: "error", label: "Sync failed" };

  // "(3/120) Rebuilding /Essays/x.md" or "(3/120) Applying settings": the
  // text, without a path, and the count apart, so the text can be cut short
  // and the count still shows
  const progress = message.match(PROGRESS);
  if (progress) {
    const text = progress[3].replace(/\s+\/.*$/, "") || "Syncing";
    const count = `${number(progress[1])} of ${number(progress[2])}`;
    const percent = Math.round((100 * progress[1]) / Math.max(1, progress[2]));
    return {
      state: "syncing",
      label: `${text} ${count}`,
      text,
      count,
      progress: Math.max(0, Math.min(100, percent)),
    };
  }

  return { state: "syncing", label: shorten(message), title: message };
};

module.exports.ago = ago;
