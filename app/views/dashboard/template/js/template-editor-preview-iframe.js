var previewIframeContainer = document.querySelector(".iframe-container");

if (previewIframeContainer) {
  var previewOrigin = previewIframeContainer.getAttribute("data-origin") || "";
  var iframe = previewIframeContainer.querySelector("iframe");
  var viewToggle = document.querySelector("[data-view-toggle]");
  var viewButtons = viewToggle ? viewToggle.querySelectorAll("button") : null;
  var previewLink = document.querySelector("a[data-preview-link]");

  var updateIframeContainerWidth = function () {
    document.documentElement.style.setProperty(
      "--iframe-container-width",
      previewIframeContainer.offsetWidth
    );
  };

  updateIframeContainerWidth();
  if (typeof window.ResizeObserver === "function") {
    var previewIframeResizeObserver = new window.ResizeObserver(
      updateIframeContainerWidth
    );
    previewIframeResizeObserver.observe(previewIframeContainer);
  } else {
    window.addEventListener("resize", updateIframeContainerWidth);
  }

  if (!iframe || !previewOrigin) {
    return;
  }

  iframe.addEventListener("load", function () {
    previewIframeContainer.classList.add("loaded");
  });

  var localStorageAvailable = false;
  try {
    localStorageAvailable = typeof window.localStorage !== "undefined";
  } catch (err) {
    localStorageAvailable = false;
  }

  var VIEW_MODE_STORAGE_KEY = "template-preview-view-mode";

  var storageKey = localStorageAvailable
    ? "template-preview-path:" + previewOrigin
    : null;
  var viewModeStorageKey = localStorageAvailable ? VIEW_MODE_STORAGE_KEY : null;

  var normalizePath = function normalizePath(path) {
    if (!path || typeof path !== "string") return "";
    var trimmed = path.trim();
    if (!trimmed) return "";
    if (trimmed.indexOf("://") !== -1) return "";
    if (trimmed.charAt(0) !== "/") {
      trimmed = "/" + trimmed;
    }
    return trimmed;
  };

  var writeStoredPath = function writeStoredPath(path) {
    if (!storageKey || !localStorageAvailable) return;
    try {
      if (path) {
        window.localStorage.setItem(storageKey, path);
      } else {
        window.localStorage.removeItem(storageKey);
      }
    } catch (err) {}
  };

  var readStoredPath = function readStoredPath() {
    if (!storageKey || !localStorageAvailable) return "";
    try {
      var value = window.localStorage.getItem(storageKey);
      return normalizePath(value);
    } catch (err) {
      return "";
    }
  };

  var isValidViewMode = function isValidViewMode(mode) {
    return mode === "desktop" || mode === "mobile";
  };

  var writeStoredViewMode = function writeStoredViewMode(mode) {
    if (!viewModeStorageKey || !localStorageAvailable) return;
    if (!isValidViewMode(mode)) {
      try {
        window.localStorage.removeItem(viewModeStorageKey);
      } catch (err) {}
      return;
    }
    try {
      window.localStorage.setItem(viewModeStorageKey, mode);
    } catch (err) {}
  };

  var readStoredViewMode = function readStoredViewMode() {
    if (!viewModeStorageKey || !localStorageAvailable) return "";
    try {
      var value = window.localStorage.getItem(viewModeStorageKey);
      if (!isValidViewMode(value)) {
        window.localStorage.removeItem(viewModeStorageKey);
        return "";
      }
      return value;
    } catch (err) {
      return "";
    }
  };

  var updatePreviewLink = function updatePreviewLink(path) {
    if (!previewLink) return;
    var href = previewOrigin;
    if (path) {
      href += path;
    }
    previewLink.href = href;
  };

  var storedPath = readStoredPath();
  var pathname = URL.parse(iframe.getAttribute("src")).pathname;
  // The page the visitor is on in the preview, with its query string
  var currentPath = storedPath || pathname;

  if (storedPath && storedPath !== pathname) {
    iframe.setAttribute("src", previewOrigin + storedPath);
  }

  updatePreviewLink(storedPath);

  // Listen to messages sent from the iframe which contains
  // the preview of the template. We inject the script
  // which sends these messages before the </body> tag of
  // all HTML pages rendered on preview subdomains.
  var receiveMessage = function receiveMessage(e) {
    if (e.origin !== previewOrigin) return;

    if (e.data && typeof e.data === "object") {
      return receivePreviewEvent(e);
    }

    if (typeof e.data !== "string" || e.data.indexOf("iframe:") !== 0) return;

    var path = normalizePath(e.data.slice("iframe:".length));

    // The visitor followed a link in the page on screen while a refresh was
    // loading the page they were on: that refresh would undo the navigation
    if (
      pendingFrame &&
      e.source === iframe.contentWindow &&
      path !== pendingPath.split("?")[0]
    ) {
      cancelSwap();
    }

    updatePreviewLink(path);
    writeStoredPath(path);
    currentPath = path || currentPath;
  };

  // Refreshing the preview: rather than reload the page in front of the
  // visitor, which shows it half styled until its stylesheets and fonts have
  // arrived, load the new one in a second iframe beside it and swap it in
  // once it has loaded. The old page stays on screen until then. Scroll
  // position lives on .iframe-scroll, not in the iframe, so it is kept.
  var SWAP_DEBOUNCE_MS = 100;
  // A page says it is ready when its fonts have loaded. One which does not
  // (the error page) is shown this long after it loads, and none is held
  // back longer than the timeout.
  var SWAP_LOAD_GRACE_MS = 1500;
  var SWAP_TIMEOUT_MS = 5000;
  var pendingFrame = null;
  // The page the pending frame is loading, with its query string
  var pendingPath = "";
  var debounceTimer = null;
  var timeoutTimer = null;

  var cancelSwap = function cancelSwap() {
    if (!pendingFrame) return;
    clearTimeout(timeoutTimer);
    pendingFrame.parentNode.removeChild(pendingFrame);
    pendingFrame = null;
  };

  var swapIn = function swapIn(next) {
    if (pendingFrame !== next) return;
    clearTimeout(timeoutTimer);
    pendingFrame = null;

    var previous = iframe;
    previous.removeAttribute("id");
    previous.parentNode.removeChild(previous);

    // The visitor may have switched between desktop and mobile while it
    // loaded, which only ever updated the frame on screen
    next.setAttribute("width", previous.getAttribute("width"));
    next.setAttribute("height", previous.getAttribute("height"));
    next.classList.toggle("mobile", previous.classList.contains("mobile"));

    next.id = "full_size_preview";
    next.style.visibility = "";
    iframe = next;

    // A refresh before the first page finished loading removes the frame
    // whose load dismisses the loading overlay
    previewIframeContainer.classList.add("loaded");
  };

  var startSwap = function startSwap() {
    cancelSwap();

    var next = iframe.cloneNode(false);
    next.removeAttribute("id");
    // Hidden, not display: none, so it still lays out and loads its fonts
    next.style.visibility = "hidden";
    pendingPath = currentPath;
    next.setAttribute("src", previewOrigin + pendingPath);
    next.addEventListener("load", function () {
      setTimeout(function () {
        swapIn(next);
      }, SWAP_LOAD_GRACE_MS);
    });

    pendingFrame = next;
    timeoutTimer = setTimeout(function () {
      swapIn(next);
    }, SWAP_TIMEOUT_MS);
    iframe.parentNode.appendChild(next);
  };

  // A save sends two triggers, the editor's own and the server's message
  // through the page, so bursts become one swap
  var scheduleSwap = function scheduleSwap() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(startSwap, SWAP_DEBOUNCE_MS);
  };

  function receivePreviewEvent(e) {
    var fromPending = pendingFrame && e.source === pendingFrame.contentWindow;

    if (e.data.type === "preview:ready") {
      if (fromPending) swapIn(pendingFrame);
      return;
    }

    if (e.data.type !== "preview:changed") return;

    // Tell the page we will refresh it, or it reloads itself
    e.source.postMessage({ type: "preview:ack" }, previewOrigin);

    // The page still loading is replaced by the swap its twin on screen starts
    if (fromPending || typeof e.data.path !== "string") return;

    currentPath = normalizePath(e.data.path) || currentPath;
    scheduleSwap();
  }

  document.addEventListener("template-preview:refresh", scheduleSwap);

  window.addEventListener("message", receiveMessage, false);

  // Desktop/Mobile toggle
  var DESKTOP = { width: 960, height: 1400, mode: "desktop" };
  var MOBILE = { width: 390, height: 844, mode: "mobile" };

  var setPreviewDimensions = function setPreviewDimensions(dim) {
    if (!iframe) return;
    iframe.setAttribute("width", String(dim.width));
    iframe.setAttribute("height", String(dim.height));
    document.documentElement.style.setProperty("--preview-width", String(dim.width));
  };

  var setView = function setView(mode) {
    var isMobile = mode === "mobile";
    setPreviewDimensions(isMobile ? MOBILE : DESKTOP);
    if (iframe) {
      if (isMobile) {
        iframe.classList.add("mobile");
      } else {
        iframe.classList.remove("mobile");
      }
    }
    if (previewIframeContainer) {
      if (isMobile) {
        previewIframeContainer.classList.add("is-mobile");
      } else {
        previewIframeContainer.classList.remove("is-mobile");
      }
      // Update --iframe-container-width after class change to reflect new container width
      updateIframeContainerWidth();
    }
    if (viewButtons) {
      for (var i = 0; i < viewButtons.length; i++) {
        var b = viewButtons[i];
        var active = b.getAttribute("data-view") === mode;
        b.classList.toggle("selected", active);
        b.setAttribute("aria-pressed", active ? "true" : "false");
      }
    }
  };

  if (viewButtons) {
    for (var i = 0; i < viewButtons.length; i++) {
      viewButtons[i].addEventListener("click", function (e) {
        var mode = this.getAttribute("data-view") || "desktop";
        if (!isValidViewMode(mode)) {
          mode = "desktop";
        }
        writeStoredViewMode(mode);
        setView(mode);
      });
    }
  }

  // Initialize view using stored mode (defaulting to desktop)
  var storedViewMode = readStoredViewMode();
  setView(storedViewMode || "desktop");
}
