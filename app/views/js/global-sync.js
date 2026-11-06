// The sync status at the top right of every site page
// (partials/global-sync.html). The server renders it; this keeps it live.
// Pages that already stream sync messages (js/sync_status.js) pass each one
// on with a "blot:sync-status" event. Other pages open a stream only while a
// sync is running, and close it once the site is synced again. Each time
// that stream opens it reads the stored status too, since a sync can finish
// before the stream is connected.

var ReconnectingEventSource = require("./reconnecting-event-source.js");

var summarise = require("./sync-summarise.js");

function render(el, message) {
  var summary = summarise(message);
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
