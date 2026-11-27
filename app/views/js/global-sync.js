// The sync status at the top right of every site page
// (partials/global-sync.html). The server renders it; this keeps it live.
// Pages that already stream sync messages (js/sync_status.js) pass each one
// on with a "blot:sync-status" event. Other pages open a stream only while a
// sync is running, and close it once the site is synced again. Each time
// that stream opens it reads the stored status too, since a sync can finish
// before the stream is connected.

var ReconnectingEventSource = require("./reconnecting-event-source.js");

var summarise = require("./sync-summarise.js");
var announce = require("./announce.js");

// Screen readers hear the sync change state (started, done, failed), not
// every progress message, through the page's one announcer
var STATE_ANNOUNCEMENTS = {
  syncing: "Syncing your folder",
  synced: "Folder synced",
  error: "Sync failed",
};

function announceState(el, state) {
  if (el.getAttribute("data-state") === state) return;
  announce(STATE_ANNOUNCEMENTS[state]);
}

// Settings which save as a choice is made say so here for a moment
// (js/site-settings-autosubmit.js): "Saving…", then "Saved" or "Not saved",
// then the pill goes back to the sync status, or to a rebuild the save
// started. Screen readers hear the save from that script, so not here.
var SAVE_STATES = {
  saving: { state: "syncing", text: "Saving…" },
  saved: { state: "synced", text: "Saved" },
  error: { state: "error", text: "Not saved" },
};
var SAVE_SHOWN_MS = { saved: 2000, error: 4000 };
var beforeSave = null;
var saveTimer = null;
// A sync message which came in while the save showed, applied after it
var heldMessage = null;

function showSave(el, name) {
  var show = SAVE_STATES[name];
  var label = el.querySelector(".global-sync__label");
  var count = el.querySelector(".global-sync__count");
  if (!show || !label) return;

  if (!beforeSave) {
    beforeSave = {
      className: el.className,
      title: el.title,
      label: label.textContent,
      count: count ? count.textContent : "",
      progress: el.style.getPropertyValue("--progress"),
    };
  }

  clearTimeout(saveTimer);
  // data-state stays the sync's, so its announcements aren't disturbed
  el.className = "global-sync is-" + show.state;
  el.style.removeProperty("--progress");
  el.title = show.text;
  label.textContent = show.text;
  if (count) count.textContent = "";

  if (SAVE_SHOWN_MS[name]) {
    saveTimer = setTimeout(function () {
      restoreSync(el);
    }, SAVE_SHOWN_MS[name]);
  }
}

// Puts back what the pill showed before the save, or the sync message which
// came in meanwhile
function restoreSync(el) {
  clearTimeout(saveTimer);
  if (!beforeSave) return;
  if (heldMessage !== null) {
    var message = heldMessage;
    beforeSave = null;
    heldMessage = null;
    render(el, message);
    return;
  }
  var label = el.querySelector(".global-sync__label");
  var count = el.querySelector(".global-sync__count");
  el.className = beforeSave.className;
  el.title = beforeSave.title;
  if (label) label.textContent = beforeSave.label;
  if (count) count.textContent = beforeSave.count;
  if (beforeSave.progress)
    el.style.setProperty("--progress", beforeSave.progress);
  beforeSave = null;
}

function render(el, message) {
  var summary = summarise(message);

  // While a save shows, only a sync in progress (a rebuild the save started)
  // replaces it; anything else waits until it ends
  if (beforeSave && summary.state !== "syncing") {
    heldMessage = message;
    return summary;
  }
  clearTimeout(saveTimer);
  beforeSave = null;
  heldMessage = null;

  announceState(el, summary.state);
  var label = el.querySelector(".global-sync__label");
  var count = el.querySelector(".global-sync__count");

  el.classList.remove("is-synced", "is-syncing", "is-error", "is-off");
  el.classList.add("is-" + summary.state);
  el.classList.toggle("has-progress", summary.progress !== undefined);
  if (summary.progress !== undefined) {
    el.style.setProperty("--progress", summary.progress + "%");
  } else {
    el.style.removeProperty("--progress");
  }
  el.setAttribute("data-state", summary.state);
  el.title = summary.title || summary.label;
  var text = summary.text || summary.label;
  if (label && label.textContent !== text) label.textContent = text;
  if (count && count.textContent !== (summary.count || "")) {
    count.textContent = summary.count || "";
  }

  return summary;
}

document.addEventListener("DOMContentLoaded", function () {
  var el = document.querySelector(".global-sync");
  if (!el) return;

  document.addEventListener("blot:settings-save", function (event) {
    showSave(el, event.detail && event.detail.state);
  });

  // A health issue (e.g. a disconnected client) outlasts sync messages
  if (
    el.getAttribute("data-state") === "error" ||
    el.getAttribute("data-state") === "off"
  )
    return;

  var stream = null;

  // Close this page's own stream once the site is synced again
  function follow(message) {
    if (render(el, message).state === "syncing") return open();
    if (stream) {
      stream.close();
      stream = null;
    }
  }

  // The stored status, e.g. after a save started a rebuild
  function check() {
    var xhr = new XMLHttpRequest();
    xhr.open("GET", el.getAttribute("data-sync-summary-url"));
    xhr.setRequestHeader("Accept", "application/json");
    xhr.onload = function () {
      try {
        if (xhr.status === 200) follow(JSON.parse(xhr.responseText).message);
      } catch (e) {}
    };
    xhr.send();
  }

  function open() {
    if (stream || window.__blotSyncStream) return;
    stream = new ReconnectingEventSource(
      el.getAttribute("data-sync-status-url")
    );
    stream.onopen = check;
    stream.onmessage = function (event) {
      follow(event.data);
    };
  }

  document.addEventListener("blot:sync-status", function (event) {
    render(el, event.detail);
  });

  // Settings that save in the background (js/site-settings-autosubmit.js)
  // can start a rebuild
  document.addEventListener("blot:sync-check", check);

  window.addEventListener("beforeunload", function () {
    if (stream) stream.close();
  });

  if (el.getAttribute("data-state") === "syncing") open();
});
