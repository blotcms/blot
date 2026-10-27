// Warms the connection to a template's preview host while the pointer rests on
// its row in the sidebar, so the preview iframe of the page the click opens
// can start at once. Only the row under the pointer, never the whole list: a
// new host costs a DNS lookup (50-100ms) and, the first time in Chrome, a new
// connection (about 500ms at a 200ms round trip). The delay keeps a sweep down
// the list from warming every row it crosses.
(function () {
  var DWELL_MS = 65;
  var warmed = {};
  var timer = null;

  // Save-Data users asked not to spend bandwidth on guesses
  if (navigator.connection && navigator.connection.saveData) return;

  function linkFor(event) {
    var target = event.target;
    return target && target.closest
      ? target.closest("a[data-preview-origin]")
      : null;
  }

  function warm(link) {
    var origin = link.getAttribute("data-preview-origin");

    if (!origin || warmed[origin]) return;
    warmed[origin] = true;

    ["dns-prefetch", "preconnect"].forEach(function (rel) {
      var hint = document.createElement("link");
      hint.rel = rel;
      hint.href = origin;
      document.head.appendChild(hint);
    });
  }

  document.addEventListener(
    "mouseover",
    function (event) {
      var link = linkFor(event);
      if (!link) return;
      clearTimeout(timer);
      timer = setTimeout(function () {
        warm(link);
      }, DWELL_MS);
    },
    { passive: true }
  );

  document.addEventListener(
    "mouseout",
    function (event) {
      if (linkFor(event)) clearTimeout(timer);
    },
    { passive: true }
  );

  // No hover on touch screens or keyboards: the press or focus is the signal
  ["touchstart", "focusin"].forEach(function (type) {
    document.addEventListener(
      type,
      function (event) {
        var link = linkFor(event);
        if (link) warm(link);
      },
      { passive: true }
    );
  });
})();
