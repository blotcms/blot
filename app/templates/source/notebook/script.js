{{{app_js}}}

(function () {
  var KEY = "notebook-archive";
  var root = document.querySelector(".sidebar .archive-list");
  if (!root || !window.localStorage) return;

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      var parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (e) {
      return {};
    }
  }

  function save(state) {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch (e) {}
  }

  var state = load();
  var nodes = root.querySelectorAll("details[data-archive-id]");
  for (var i = 0; i < nodes.length; i++) {
    var id = nodes[i].getAttribute("data-archive-id");
    if (Object.prototype.hasOwnProperty.call(state, id)) {
      nodes[i].open = !!state[id];
    }
  }

  root.addEventListener("toggle", function (e) {
    var el = e.target;
    if (!el || el.tagName !== "DETAILS") return;
    var id = el.getAttribute("data-archive-id");
    if (!id) return;
    state[id] = el.open;
    save(state);
  }, true);
})();
