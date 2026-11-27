// Keeps the Sites list's Sync column live: one stream (/sites/status) for
// every site, each message naming its site. The server renders the column;
// this updates a row as its site syncs.

var ReconnectingEventSource = require("./reconnecting-event-source.js");

var summarise = require("./sync-summarise.js");

function span(className, text) {
  var el = document.createElement("span");
  el.className = className;
  el.textContent = text;
  return el;
}

// One polite live region for the page: told only when a site finishes
// syncing or fails, not on every progress message
function announce(cell, state) {
  var region = document.getElementById("sites-sync-announcer");
  if (!region) return;
  var name =
    cell.getAttribute("data-site-name") || cell.getAttribute("data-sites-sync");
  // Clear first so the same message is read again if it repeats
  region.textContent = "";
  region.textContent = name + (state === "synced" ? " synced" : " sync failed");
}

function render(cell, message) {
  var summary = summarise(message);
  var previous = cell.className;
  var text = cell.querySelector(".sites-sync__text");
  var hasProgress = summary.progress !== undefined;

  cell.className =
    "sites-sync is-" + summary.state + (hasProgress ? " has-progress" : "");
  if (hasProgress) cell.style.setProperty("--progress", summary.progress + "%");
  else cell.style.removeProperty("--progress");

  if (
    (summary.state === "synced" || summary.state === "error") &&
    previous.indexOf("is-" + summary.state) === -1
  ) {
    announce(cell, summary.state);
  }

  if (!text) return;
  text.textContent = "";

  if (summary.state === "syncing") {
    text.appendChild(span("sites-sync__label", summary.text || summary.label));
    text.appendChild(span("global-sync__count", summary.count || ""));
  } else if (summary.state === "synced") {
    text.textContent = "Just now";
    // Sorting by this column puts the site first again
    var td = cell.closest("td");
    if (td) td.setAttribute("data-sort-value", String(Date.now()));
  } else {
    text.textContent = summary.label;
  }
}

document.addEventListener("DOMContentLoaded", function () {
  var cells = document.querySelectorAll("[data-sites-sync]");
  if (!cells.length) return;

  var byHandle = {};
  cells.forEach(function (cell) {
    byHandle[cell.getAttribute("data-sites-sync")] = cell;
  });

  var stream = new ReconnectingEventSource("/sites/status");

  stream.onmessage = function (event) {
    var data;
    try {
      data = JSON.parse(event.data);
    } catch (e) {
      return;
    }
    if (byHandle[data.handle]) render(byHandle[data.handle], data.message);
  };

  window.addEventListener("beforeunload", function () {
    stream.close();
  });
});
