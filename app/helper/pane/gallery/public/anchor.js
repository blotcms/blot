// Keeps the page scrolled to the section named by the URL's #fragment. The browser scrolls to the
// anchor once, while the page is still being laid out: the reference captures load afterwards and
// are sized by script, so every section above the target changes height and the one-off scroll
// lands on the wrong place (or on the top). go() scrolls to the anchor again, instantly, and the
// gallery calls it after each image has loaded, until the reader scrolls by themselves.
// Also loaded by Node (tests/gallery.js) with stand-ins for window and document.
(function (root) {
  function keepAnchor(win, doc) {
    let active = true;
    const stop = () => {
      active = false;
    };
    ["wheel", "touchstart", "keydown", "mousedown"].forEach((type) =>
      win.addEventListener(type, stop, { passive: true })
    );
    // a later #fragment (a nav link) is the browser's to scroll, and starts following again
    win.addEventListener("hashchange", () => {
      active = true;
    });
    return {
      go() {
        if (!active) return false;
        let id = String(win.location.hash || "").slice(1);
        try {
          id = decodeURIComponent(id);
        } catch (err) {
          // a malformed escape: use it as written
        }
        const el = id && doc.getElementById(id);
        if (!el) return false;
        el.scrollIntoView({ behavior: "instant", block: "start" });
        return true;
      },
      stop,
    };
  }
  if (typeof module !== "undefined" && module.exports)
    module.exports = keepAnchor;
  else root.paneKeepAnchor = keepAnchor;
})(this);
