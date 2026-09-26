require("./reconnecting-event-source.js");

var THROTTLE_DELAY = 2000; // ms

var inFlight = false;
var nextAt = 0;
var timerId = null;
var pendingWhileHidden = false;
var evtSource = null;
var shouldReload = false;
var lastRawMessage = null;
var PROGRESS_MESSAGE_RE = /^\((\d+)\/(\d+)\)\s*(.*)$/;

function q(sel) {
  return document.querySelector(sel);
}

function parseSyncStatusMessage(message) {
  var match = (message || "").match(PROGRESS_MESSAGE_RE);

  if (!match) {
    return {
      hasProgress: false,
      text: message || "",
      current: 0,
      total: 0,
      percent: 0,
    };
  }

  var current = parseInt(match[1], 10);
  var total = parseInt(match[2], 10);
  var percent = total > 0 ? (current / total) * 100 : 0;

  percent = Math.max(0, Math.min(100, percent));

  return {
    hasProgress: true,
    text: match[3] || "",
    current: current,
    total: total,
    percent: percent,
  };
}

function shortenSyncingFilename(message) {
  if (message.startsWith("Syncing /")) {
    var path = message.slice("Syncing ".length);
    var filename = path.split("/").pop();
    return "Syncing " + filename;
  }

  return message;
}

function renderSyncStatusMessage(message) {
  var statusContainer = q(".sync-status");
  if (!statusContainer) return;

  var statusText = q(".sync-status-text");
  if (!statusText) return;

  // The server rendered a client health issue in place of the sync status.
  // Live messages must not overwrite it; it clears when the page fragment
  // is re-fetched (see loadFolder) after the client recovers.
  if (statusContainer.hasAttribute("data-health")) return;

  if (typeof message === "undefined") {
    // Re-apply the last raw status we were given. We must not read it back
    // from statusText.innerText, because the render below replaces that with
    // the shortened text (the "(current/total)" progress prefix stripped).
    // Re-parsing the shortened text would report no progress and reset the
    // bar to 0% on every subsequent no-argument render.
    message =
      lastRawMessage !== null ? lastRawMessage : statusText.innerText || "";
  }

  // Remember the raw, unshortened status so later no-argument renders can
  // recover the progress prefix.
  lastRawMessage = message;

  var parsed = parseSyncStatusMessage(message);
  var visibleMessage = shortenSyncingFilename(parsed.text);
  var progressBar = q(".sync-status-progress-bar");
  var progressLabel = q(".sync-status-progress-label");
  // Folder footer stays a single compact status line. Drive/iCloud syncs still
  // emit "(n/m) ..." messages; show the text, but never expand into a bar here.
  var hideProgress = !!statusContainer.closest(".status-link");

  statusText.innerText = visibleMessage;

  if (parsed.hasProgress && !hideProgress) {
    var roundedPercent = Math.round(Math.max(0, Math.min(100, parsed.percent)));

    statusContainer.classList.add("has-progress");
    if (progressBar) progressBar.style.width = roundedPercent + "%";
    if (progressLabel) progressLabel.innerText = roundedPercent + "% complete";
  } else {
    statusContainer.classList.remove("has-progress");
    if (progressBar) progressBar.style.width = "0%";
    if (progressLabel) progressLabel.innerText = "";
  }

  updateContainerClass();
}

function updateContainerClass() {
  var statusContainer = q(".sync-status");
  var statusTextElement = q(".sync-status-text");
  var statusText = statusTextElement ? statusTextElement.innerText || "" : "";

  if (!statusContainer) return;

  if (statusText.startsWith("Synced")) {
    statusContainer.classList.remove("syncing", "error");
    statusContainer.classList.add("synced");
  } else if (statusText.startsWith("Error")) {
    statusContainer.classList.remove("syncing", "synced");
    statusContainer.classList.add("error");
  } else {
    statusContainer.classList.remove("synced", "error");
    statusContainer.classList.add("syncing");
  }
}

function scheduleLoad() {
  if (document.visibilityState === "hidden") {
    pendingWhileHidden = true;
    return;
  }

  var now = Date.now();
  var when = Math.max(nextAt, now);

  if (timerId) {
    shouldReload = true;
    return;
  }

  if (!inFlight && now >= nextAt) {
    runLoad();
  } else {
    timerId = setTimeout(function () {
      timerId = null;
      runLoad();
    }, when - now);
  }
}

function runLoad() {
  if (inFlight) return;
  inFlight = true;
  var started = Date.now();

  loadFolder(function done() {
    inFlight = false;
    nextAt = started + THROTTLE_DELAY;
    // If events piled up, one schedule() coalesces them.
    if (shouldReload) {
      shouldReload = false;
      scheduleLoad();
    }
  });
}

function loadFolder(callback) {
  var xhr = new XMLHttpRequest();

  xhr.onreadystatechange = function () {
    if (xhr.readyState === 4) {
      if (xhr.status === 200) {
        var parser = new DOMParser();
        var xml = parser.parseFromString(xhr.responseText, "text/html");

        var currentNode = q(".live-updates");
        var newNode = xml.querySelector(".live-updates");

        if (currentNode && newNode) {
          var currentState = currentNode.innerHTML;
          var newState = newNode.innerHTML;

          if (newState !== currentState) {
            currentNode.innerHTML = newState;

            try {
              sortTable();
            } catch (e) {
              console.error(e);
            }
            try {
              initCopyButtons();
            } catch (e) {
              console.error(e);
            }
            try {
              renderSyncStatusMessage();
            } catch (e) {
              console.error(e);
            }
          }
        }

        // On pages like the folder footer, the .sync-status line lives
        // outside .live-updates so the syncing/synced animation (driven by
        // classes toggled in place by renderSyncStatusMessage) isn't wiped
        // out by an innerHTML swap on every load. But that also means a
        // health issue appearing/clearing on the server (data-health added,
        // removed or changed) never reaches this element via the diff
        // above. Swap it in on its own, only when the health state itself
        // differs, so the animated classes are left alone the rest of the
        // time.
        try {
          var currentStatus = q(".sync-status");
          var newStatus = xml.querySelector(".sync-status");
          var statusIsLive = currentNode && currentStatus && currentNode.contains(currentStatus);

          if (currentStatus && newStatus && !statusIsLive) {
            var oldHealth = currentStatus.hasAttribute("data-health")
              ? currentStatus.getAttribute("data-health")
              : null;
            var newHealth = newStatus.hasAttribute("data-health")
              ? newStatus.getAttribute("data-health")
              : null;

            if (oldHealth !== newHealth) {
              var importedStatus = document.importNode(newStatus, true);
              currentStatus.replaceWith(importedStatus);
              renderSyncStatusMessage();
            }
          }
        } catch (e) {
          console.error(e);
        }

        // The folder header's health badge lives outside .live-updates too
        // (it's above the file table), so it needs the same treatment: swap
        // its contents in from the fetched doc whenever they differ, rather
        // than relying on the .live-updates diff above.
        try {
          var currentBadge = q(".header-health-badge");
          var newBadge = xml.querySelector(".header-health-badge");

          if (currentBadge && newBadge && currentBadge.innerHTML !== newBadge.innerHTML) {
            currentBadge.innerHTML = newBadge.innerHTML;
          }
        } catch (e) {
          console.error(e);
        }
      } else {
        console.error("Failed to load folder:", xhr.status);
      }
      callback();
    }
  };

  xhr.open("GET", window.location.href, true);
  xhr.send();
}

function attachSSE() {
  var statusContainer = q(".sync-status");
  if (!statusContainer) return;

  renderSyncStatusMessage();

  var syncStatusURL = statusContainer.getAttribute("data-sync-status-url");
  if (!syncStatusURL) {
    console.error("No sync status URL provided.");
    return;
  }

  if (evtSource) evtSource.close();
  evtSource = new ReconnectingEventSource(syncStatusURL);

  evtSource.onmessage = function (event) {
    var message = event.data || "";

    renderSyncStatusMessage(message);

    if (q(".live-updates")) {
      scheduleLoad();
    }
  };
}

// One-time listeners
document.addEventListener("visibilitychange", function () {
  if (document.visibilityState === "visible" && pendingWhileHidden) {
    pendingWhileHidden = false;
    scheduleLoad();
  }
});

window.addEventListener("beforeunload", function () {
  if (evtSource) evtSource.close();
});

// First attach on initial load
document.addEventListener("DOMContentLoaded", function () {
  attachSSE();
});