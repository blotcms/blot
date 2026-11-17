{{{app_js}}}

// Page 1 of a listing is the listing itself: link there, not to /page/1
(function () {
  var links = document.querySelectorAll('.blog-pager a[href="/page/1"], .pager a[href$="/page/1"]');
  for (var i = 0; i < links.length; i++) {
    links[i].setAttribute("href", links[i].getAttribute("href").replace(/\/page\/1$/, "") || "/");
  }
})();

// The sidebar archive: which years and months a reader left open, and the
// months and posts of older years, fetched from /archives/tree (see
// archive-tree.html) the first time one of them is opened
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

  function restore(container) {
    var nodes = container.querySelectorAll("details[data-archive-id]");
    for (var i = 0; i < nodes.length; i++) {
      var id = nodes[i].getAttribute("data-archive-id");
      if (Object.prototype.hasOwnProperty.call(state, id)) {
        nodes[i].open = !!state[id];
      }
    }
  }

  var tree = null;

  function fetchTree() {
    if (!tree && window.fetch) {
      tree = fetch("/archives/tree", { credentials: "same-origin" })
        .then(function (res) {
          if (!res.ok) throw new Error("Status " + res.status);
          return res.text();
        })
        .then(function (html) {
          // Kept for the script in sidebar.html, which uses it to paint the
          // archive already open next time. A new cacheID retires it.
          try {
            if (storage && html.length < 500000) {
              storage.setItem(TREE_KEY, JSON.stringify({ id: "{{cacheID}}", html: html }));
            }
          } catch (e) {}
          var holder = document.createElement("div");
          holder.innerHTML = html;
          return holder;
        })
        .catch(function () {
          // Leave the links to the archives page, and try again next time
          tree = null;
          return null;
        });
    }
    return tree || Promise.resolve(null);
  }

  // Swaps an older year's link to the archives page for its months
  function fill(year) {
    fetchTree().then(function (holder) {
      if (!holder) return;
      var months = holder.querySelector('[data-archive-year="' + year + '"] .archive-months');
      var details = root.querySelector('details[data-archive-year="' + year + '"]');
      if (!months || !details || !details.hasAttribute("data-archive-year")) return;
      var fallback = details.querySelector(".archive-fallback");
      if (fallback) fallback.parentNode.removeChild(fallback);
      details.appendChild(months);
      details.removeAttribute("data-archive-year");
      restore(details);
    });
  }

  var state = load();
  restore(root);

  var waiting = root.querySelectorAll("details[data-archive-year]");
  for (var i = 0; i < waiting.length; i++) {
    if (waiting[i].open) fill(waiting[i].getAttribute("data-archive-year"));
  }

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
