var previewIframeContainer = document.querySelector(".iframe-container");

if (previewIframeContainer) {
  var previewOrigin = previewIframeContainer.getAttribute("data-origin") || "";
  var iframe = previewIframeContainer.querySelector("iframe");
  var viewToggle = document.querySelector("[data-view-toggle]");
  var viewButtons = viewToggle ? viewToggle.querySelectorAll("button") : null;
  var previewLink = document.querySelector("a[data-preview-link]");

  var iframeContainerWidth = previewIframeContainer.offsetWidth;
  document.documentElement.style.setProperty(
    "--iframe-container-width",
    iframeContainerWidth
  );
  window.addEventListener("resize", function () {
    var iframeContainerWidth = previewIframeContainer.offsetWidth;
    document.documentElement.style.setProperty(
      "--iframe-container-width",
      iframeContainerWidth
    );
  });

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

  if (storedPath && storedPath !== pathname) {
    console.log('updating iframe url')
    iframe.setAttribute("src", previewOrigin + storedPath);
  } else {
    console.log('iframe matches');
  }

  updatePreviewLink(storedPath);

  // Listen to messages sent from the iframe which contains
  // the preview of the template. We inject the script
  // which sends these messages before the </body> tag of
  // all HTML pages rendered on preview subdomains.
  var receiveMessage = function receiveMessage(e) {
    if (e.origin !== previewOrigin) return;
    if (typeof e.data !== "string" || e.data.indexOf("iframe:") !== 0) return;

    var path = normalizePath(e.data.slice("iframe:".length));

    updatePreviewLink(path);
    writeStoredPath(path);
  };

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
      var iframeContainerWidth = previewIframeContainer.offsetWidth;
      document.documentElement.style.setProperty(
        "--iframe-container-width",
        iframeContainerWidth
      );
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
