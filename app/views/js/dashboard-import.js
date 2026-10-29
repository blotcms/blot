const importContainer = document.querySelector("[data-import-base]");
const liveUpdatesContainer = document.querySelector(".live-updates");
const importStatusContainer = document.querySelector('[id^="status-"]');
const PROGRESS_MESSAGE_RE = /^\((\d+)\/(\d+)\)\s*(.*)$/;
const BLOGGER_SITE_URL_KEY = "blot-blogger-import-site-url";

(function rememberBloggerSiteURL() {
  const input = document.getElementById("blogger-site-url");
  if (!input || !input.form) return;

  try {
    const saved = localStorage.getItem(BLOGGER_SITE_URL_KEY);
    if (saved && !input.value) input.value = saved;
  } catch (e) {}

  input.form.addEventListener("submit", function () {
    const value = (input.value || "").trim();
    try {
      if (value) localStorage.setItem(BLOGGER_SITE_URL_KEY, value);
      else localStorage.removeItem(BLOGGER_SITE_URL_KEY);
    } catch (e) {}
  });
})();

function renderImportStatus(statusNode, message) {
  const match = (message || "").match(PROGRESS_MESSAGE_RE);
  const statusContainer = statusNode.closest(".sync-status");
  const progress = statusContainer
    ? statusContainer.querySelector(".sync-status-progress")
    : null;
  const progressBar = progress
    ? progress.querySelector(".sync-status-progress-bar")
    : null;
  const progressLabel = statusContainer
    ? statusContainer.querySelector(".sync-status-progress-label")
    : null;

  statusNode.textContent = match
    ? match[3] || "Processing..."
    : "Processing...";

  if (statusContainer && match) {
    const current = parseInt(match[1], 10);
    const total = parseInt(match[2], 10);
    const percent = total > 0 ? (current / total) * 100 : 0;
    const clampedPercent = Math.max(0, Math.min(100, percent));
    const roundedPercent = Math.round(clampedPercent);

    statusContainer.classList.add("has-progress");
    if (progress) progress.style.display = "block";
    if (progressBar) progressBar.style.width = roundedPercent + "%";
    if (progressLabel) progressLabel.textContent = roundedPercent + "% complete";
  } else if (statusContainer) {
    statusContainer.classList.remove("has-progress");
    if (progress) progress.style.display = "none";
    if (progressBar) progressBar.style.width = "0%";
    if (progressLabel) progressLabel.textContent = "";
  }
}

function renderImportStatuses() {
  document.querySelectorAll('[id^="status-"]').forEach(function (statusNode) {
    renderImportStatus(statusNode, statusNode.textContent);
  });
}

function isTerminalImportStatus(status) {
  return status === "Finished" || status === "Failed";
}

if (importContainer && (liveUpdatesContainer || importStatusContainer)) {
  const ReconnectingEventSource = require("./reconnecting-event-source.js");

  const importBase = importContainer.getAttribute("data-import-base");

  if (importBase) {
    const evtSource = new ReconnectingEventSource(`${importBase}/status`);

    let currentlyLoading = false;
    let checkAgain = false;

    renderImportStatuses();

    // Statuses published while the stream was down are lost, so reload the
    // list (which renders each import's last status) when it re-opens after a
    // drop. The first open is skipped: the page was just rendered.
    let hasOpened = false;
    evtSource.onopen = function () {
      if (hasOpened) refreshFolder();
      hasOpened = true;
    };

    evtSource.onmessage = function (event) {
      const { status, importID } = JSON.parse(event.data);

      const statusNode = document.getElementById("status-" + importID);

      if (!statusNode) {
        return;
      }

      statusNode.removeAttribute("data-text");
      renderImportStatus(statusNode, status);

      if (isTerminalImportStatus(status)) {
        refreshFolder();
      }
    };

    function refreshFolder() {
      if (currentlyLoading) {
        checkAgain = true;
        return;
      }

      currentlyLoading = true;

      if (!document.querySelector(".live-updates")) {
        currentlyLoading = false;
        return;
      }

      loadFolder(function onLoad() {
        if (checkAgain === true) {
          checkAgain = false;
          return loadFolder(onLoad);
        }

        currentlyLoading = false;
      });
    }

    function loadFolder(callback) {
      const xhr = new XMLHttpRequest();

      xhr.onreadystatechange = function () {
        if (xhr.readyState == 4 && xhr.status == 200) {
          const parser = new DOMParser();
          const xml = parser.parseFromString(xhr.responseText, "text/html");

          const currentNode = document.querySelector(".live-updates");
          const newNode = xml.querySelector(".live-updates");

          if (currentNode !== null && newNode !== null) {
            const currentState = currentNode.innerHTML;
            const newState = newNode.innerHTML;

            if (newState === currentState) return callback();

            currentNode.innerHTML = newState;
            renderImportStatuses();
          }

          callback();
        }
      };

      xhr.open("GET", window.location, true);
      xhr.setRequestHeader("Content-type", "text/html");
      xhr.send();
    }
  }
}
