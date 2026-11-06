(function () {
  var root = document.documentElement;
  var storageKey = "dashboard-sidebar-width";
  var getCssNumber = function (name, fallback) {
    var value = parseFloat(
      window.getComputedStyle(root).getPropertyValue(name)
    );
    return isFinite(value) ? value : fallback;
  };
  var minWidth = getCssNumber("--dashboard-sidebar-min-width", 140);
  var maxWidth = getCssNumber("--dashboard-sidebar-max-width", 480);
  var defaultWidth = getCssNumber("--dashboard-sidebar-default-width", 296);
  var width = getCssNumber("--dashboard-sidebar-width", defaultWidth);

  try {
    var storedWidth = parseFloat(window.localStorage.getItem(storageKey));
    if (isFinite(storedWidth)) {
      width = Math.round(Math.max(minWidth, Math.min(maxWidth, storedWidth)));
    }
  } catch (err) {}

  var setWidth = function (nextWidth) {
    width = Math.round(Math.max(minWidth, Math.min(maxWidth, nextWidth)));
    root.style.setProperty("--dashboard-sidebar-width", width + "px");
  };

  var persist = function () {
    try {
      window.localStorage.setItem(storageKey, String(width));
    } catch (err) {}
  };

  var updateHandle = function (handle) {
    handle.setAttribute("aria-valuemin", String(minWidth));
    handle.setAttribute("aria-valuemax", String(maxWidth));
    handle.setAttribute("aria-valuenow", String(width));
    handle.setAttribute("aria-valuetext", width + " pixels");
  };

  document
    .querySelectorAll("[data-dashboard-sidebar-resize-handle]")
    .forEach(function (handle) {
      var sidebar = handle.closest("[data-dashboard-sidebar]");
      if (!sidebar) return;

      var drag = null;
      updateHandle(handle);

      var finish = function (event) {
        if (!drag || (event && event.pointerId !== drag.pointerId)) return;
        drag = null;
        document.body.classList.remove("is-resizing-dashboard-sidebar");
        persist();
        updateHandle(handle);
      };

      handle.addEventListener("pointerdown", function (event) {
        if (event.button !== undefined && event.button !== 0) return;
        // No focus() here: a handle focused by the mouse would keep the
        // :focus-visible colour after the drag
        event.preventDefault();
        drag = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startWidth: width,
        };
        handle.setPointerCapture(event.pointerId);
        document.body.classList.add("is-resizing-dashboard-sidebar");
      });

      handle.addEventListener("pointermove", function (event) {
        if (!drag || event.pointerId !== drag.pointerId) return;
        var candidateWidth = drag.startWidth + event.clientX - drag.startX;
        setWidth(candidateWidth);
        updateHandle(handle);
      });

      handle.addEventListener("pointerup", finish);
      handle.addEventListener("pointercancel", finish);
      handle.addEventListener("lostpointercapture", finish);
      handle.addEventListener("keydown", function (event) {
        var step = event.shiftKey ? 40 : 10;
        var nextWidth = width;
        if (event.key === "ArrowLeft") nextWidth -= step;
        else if (event.key === "ArrowRight") nextWidth += step;
        else if (event.key === "Home") nextWidth = minWidth;
        else if (event.key === "End") nextWidth = maxWidth;
        else return;

        event.preventDefault();
        setWidth(nextWidth);
        persist();
        updateHandle(handle);
      });

      handle.addEventListener("dblclick", function (event) {
        event.preventDefault();
        setWidth(defaultWidth);
        persist();
        updateHandle(handle);
      });
    });
})();
