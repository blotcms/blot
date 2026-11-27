// Turns a sync message into what the dashboard shows for it: a state
// (synced, syncing, error), a label, and for counted work its text, count
// and progress. Used by js/global-sync.js and js/sites-sync.js; the server
// does the same in app/dashboard/util/sync-summary.js.

var PROGRESS = /^\((\d+)\/(\d+)\)\s*(.*)$/;

function number(n) {
  return Number(n).toLocaleString("en-US");
}

function summarise(message) {
  message = message || "";

  if (message === "Synced")
    return { state: "synced", label: "Synced just now" };
  if (/^error/i.test(message)) return { state: "error", label: "Sync failed" };

  // The text without a path, and the count apart (see sync-summary.js)
  var progress = message.match(PROGRESS);
  if (progress) {
    var text = progress[3].replace(/\s+\/.*$/, "") || "Syncing";
    var count = number(progress[1]) + " of " + number(progress[2]);
    var percent = Math.round((100 * progress[1]) / Math.max(1, progress[2]));
    return {
      state: "syncing",
      label: text + " " + count,
      text: text,
      count: count,
      progress: Math.max(0, Math.min(100, percent)),
    };
  }

  return {
    state: "syncing",
    label: message
      .replace(/^(\w+) \/.*\/([^/]+)$/, "$1 $2")
      .replace(/^(\w+) \/([^/]+)$/, "$1 $2"),
    title: message,
  };
}

module.exports = summarise;
