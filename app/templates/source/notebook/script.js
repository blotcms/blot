{{{app_js}}}

// Page 1 of a listing is the listing itself: link there, not to /page/1
(function () {
  var links = document.querySelectorAll('.blog-pager a[href="/page/1"], .pager a[href$="/page/1"]');
  for (var i = 0; i < links.length; i++) {
    links[i].setAttribute("href", links[i].getAttribute("href").replace(/\/page\/1$/, "") || "/");
  }
})();

// The sidebar archive: which years and months a reader left open, and the
// posts of older years, fetched from /archives/tree (see archive-tree.html)
// the first time one of them is opened. The months are in the page already.
(function () {
  var KEY = "notebook-archive";
  var TREE_KEY = "notebook-archive-tree";
  var root = document.querySelector(".sidebar .archive-list");
  if (!root) return;

  // Reading localStorage throws where site data is blocked
  var storage = null;
  try {
    storage = window.localStorage;
  } catch (e) {}

  function load() {
    try {
      var raw = storage && storage.getItem(KEY);
      var parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (e) {
      return {};
    }
  }

  function save() {
    try {
      if (storage) storage.setItem(KEY, JSON.stringify(state));
    } catch (e) {}
  }

  var tree = null;

  // The copy kept from an earlier page of this cacheID, if any
  function cachedTree() {
    try {
      var saved = storage && JSON.parse(storage.getItem(TREE_KEY));
      if (saved && saved.id === window.notebookCacheID) return saved.html;
    } catch (e) {}
    return null;
  }

  function parse(html) {
    var holder = document.createElement("div");
    holder.innerHTML = html;
    return holder;
  }

  function fetchTree() {
    if (!tree) {
      var saved = cachedTree();
      if (saved !== null) {
        tree = Promise.resolve(parse(saved));
      } else if (window.fetch) {
        tree = fetch("/archives/tree", { credentials: "same-origin" })
          .then(function (res) {
            if (!res.ok) throw new Error("Status " + res.status);
            return res.text();
          })
          .then(function (html) {
            // Kept for the script in sidebar.html, which uses it to paint the
            // archive already open next time. A new cacheID retires it.
            try {
              if (storage && window.notebookCacheID && html.length < 500000) {
                storage.setItem(TREE_KEY, JSON.stringify({ id: window.notebookCacheID, html: html }));
              }
            } catch (e) {}
            return parse(html);
          })
          .catch(function () {
            // The months stay, without their posts, and it is tried again
            // next time
            tree = null;
            return null;
          });
      }
    }
    return tree || Promise.resolve(null);
  }

  // Puts an older year's posts into the months already in the page
  function fill(year) {
    fetchTree().then(function (holder) {
      if (!holder) return;
      var details = root.querySelector('details[data-archive-year="' + year + '"]');
      if (!details) return;
      var months = holder.querySelectorAll('[data-archive-year="' + year + '"] details[data-archive-id]');
      for (var i = 0; i < months.length; i++) {
        var id = months[i].getAttribute("data-archive-id");
        var mine = details.querySelector('details[data-archive-id="' + id + '"] .archive-posts');
        var posts = months[i].querySelector(".archive-posts");
        if (mine && posts) mine.parentNode.replaceChild(posts, mine);
      }
      details.removeAttribute("data-archive-year");
    });
  }

  var state = load();
  var saved = root.querySelectorAll("details[data-archive-id]");
  for (var n = 0; n < saved.length; n++) {
    var id = saved[n].getAttribute("data-archive-id");
    if (Object.prototype.hasOwnProperty.call(state, id)) saved[n].open = !!state[id];
  }

  var waiting = root.querySelectorAll("details[data-archive-year]");
  for (var i = 0; i < waiting.length; i++) {
    if (waiting[i].open) fill(waiting[i].getAttribute("data-archive-year"));
  }

  // Start the request as a reader reaches for a year, so it is often back
  // by the time they open a month
  root.addEventListener("mouseover", function (e) {
    var summary = e.target.closest && e.target.closest("summary");
    if (summary && summary.parentNode.hasAttribute("data-archive-year")) fetchTree();
  });

  root.addEventListener("toggle", function (e) {
    var el = e.target;
    if (!el || el.tagName !== "DETAILS") return;
    if (el.open && el.hasAttribute("data-archive-year")) {
      fill(el.getAttribute("data-archive-year"));
    }
    var id = el.getAttribute("data-archive-id");
    if (!id) return;
    state[id] = el.open;
    save();
  }, true);
})();
