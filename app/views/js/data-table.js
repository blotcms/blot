// Sorting and column resizing for tables with class "data-table" (see
// app/views/dashboard/css/data-table.css).
//
// Sorting: each sortable <th> has data-sort-key and holds a .data-table__sort
// button. The table's data-table-sort says who sorts:
//   "client"  this script reorders the rows already in the page, by each
//             cell's data-sort-value (or its text); data-sort-type="number"
//             on the <th> compares numerically. The choice is remembered.
//   "custom"  the page's own script sorts: it sets table.dataTableSort to
//             { getState() -> { sort, order }, onSort(sort, order) } before
//             this script runs (the folder listing pages through the server).
//
// Resizing: data-table-resizable adds a handle between each pair of columns.
// Dragging moves the border between the two, so the table keeps its width,
// and the widths are kept as percentages in localStorage under
// data-table-resize-key.

var announce = require("./announce.js");

var MIN_WIDTH = 48;

function load(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch (e) {
    return null;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {}
}

function remove(key) {
  try {
    localStorage.removeItem(key);
  } catch (e) {}
}

function sortableHeaders(table) {
  return Array.prototype.slice.call(
    table.querySelectorAll("thead th[data-sort-key]")
  );
}

function updateIndicators(table, sort, order) {
  sortableHeaders(table).forEach(function (th) {
    var active = th.getAttribute("data-sort-key") === sort;
    th.setAttribute(
      "aria-sort",
      active ? (order === "desc" ? "descending" : "ascending") : "none"
    );
  });
}

function defaultOrder(th) {
  return th.getAttribute("data-sort-default") || "asc";
}

// Also kept in a cookie of the same name, so a table marked
// data-sorted-on-server comes from the server already in this order (the
// Sites list, app/dashboard/index.js)
// Data-sorted-on-server tables (the Sites list, app/dashboard/index.js).
// No sort expires it, for the default order.
function saveCookie(key, state) {
  document.cookie = state.sort
    ? key +
      "=" +
      encodeURIComponent(state.sort + "." + state.order) +
      "; path=/sites; max-age=31536000; SameSite=Lax"
    : key + "=; path=/sites; max-age=0; SameSite=Lax";
}

// Sorts the rows in the page by one column. With no column chosen, rows are
// in the default order: by data-default-sort, in that column's own direction.
function clientSorter(table) {
  var storageKey = table.getAttribute("data-table-sort-key");
  var headers = Array.prototype.slice.call(table.querySelectorAll("thead th"));
  var rendered = {
    sort: table.getAttribute("data-sort") || null,
    order: table.getAttribute("data-order") || "asc",
  };
  var initial = (storageKey && load(storageKey)) || rendered;
  var state = { sort: initial.sort, order: initial.order };
  var sortedOnServer =
    table.hasAttribute("data-sorted-on-server") &&
    state.sort === rendered.sort &&
    state.order === rendered.order;

  function value(row, index, numeric) {
    var cell = row.children[index];
    if (!cell) return numeric ? -Infinity : "";
    var raw = cell.hasAttribute("data-sort-value")
      ? cell.getAttribute("data-sort-value")
      : cell.textContent.trim();
    if (!numeric) return raw;
    var number = parseFloat(raw);
    return isNaN(number) ? -Infinity : number;
  }

  function apply() {
    var key = state.sort || table.getAttribute("data-default-sort");
    var th = table.querySelector('thead th[data-sort-key="' + key + '"]');
    if (!th) return;
    var index = headers.indexOf(th);
    var numeric = th.getAttribute("data-sort-type") === "number";
    var order = state.sort ? state.order : defaultOrder(th);
    var direction = order === "desc" ? -1 : 1;
    var tbody = table.tBodies[0];
    var rows = Array.prototype.slice.call(tbody.rows);

    rows.sort(function (a, b) {
      var x = value(a, index, numeric);
      var y = value(b, index, numeric);
      var result = numeric
        ? x - y
        : String(x).localeCompare(String(y), undefined, {
            numeric: true,
            sensitivity: "base",
          });
      return result * direction;
    });

    rows.forEach(function (row) {
      tbody.appendChild(row);
    });
  }

  // Rows the server already sorted stay as they are. Otherwise (a choice saved
  // before the cookie existed) sort them now, and keep the choice in the
  // cookie so the next page comes sorted.
  if (state.sort && !sortedOnServer) {
    apply();
    if (storageKey && table.hasAttribute("data-sorted-on-server")) {
      saveCookie(storageKey, state);
    }
  }

  return {
    getState: function () {
      return state;
    },
    onSort: function (sort, order) {
      state = { sort: sort, order: order };
      apply();
      if (storageKey) {
        if (sort) save(storageKey, state);
        else remove(storageKey);
        if (table.hasAttribute("data-sorted-on-server"))
          saveCookie(storageKey, state);
      }
    },
  };
}

// Headers whose sort is a link to the next one (rendered by the server):
// a click anywhere in the cell follows it
function bindSortLinks(table) {
  sortableHeaders(table).forEach(function (th) {
    var link = th.querySelector("a.data-table__sort");
    if (!link) return;
    th.addEventListener("click", function (event) {
      if (event.target.closest(".data-table__resize, a")) return;
      link.click();
    });
  });
}

function bindSorting(table) {
  var mode = table.getAttribute("data-table-sort");
  if (mode === "link") return bindSortLinks(table);
  var sorter = mode === "client" ? clientSorter(table) : table.dataTableSort;
  if (!sorter) return;

  sortableHeaders(table).forEach(function (th) {
    // The button takes focus and the keyboard; the header cell stays
    // clickable as a whole. Clicks cycle through the column's own direction,
    // the other direction, then the table's default order (no arrow).
    th.addEventListener("click", function (event) {
      if (event.target.closest(".data-table__resize")) return;
      var key = th.getAttribute("data-sort-key");
      var state = sorter.getState();
      var first = defaultOrder(th);

      if (state.sort === key && state.order !== first) {
        updateIndicators(table, null);
        sorter.onSort(null, null);
        announce("Default order restored");
        return;
      }

      var order =
        state.sort === key ? (first === "asc" ? "desc" : "asc") : first;
      updateIndicators(table, key, order);
      sorter.onSort(key, order);
      // aria-sort on the header isn't read when the button is pressed
      announce(
        "Sorted by " +
          th.textContent.trim() +
          ", " +
          (order === "desc" ? "descending" : "ascending")
      );
    });
  });

  var state = sorter.getState();
  updateIndicators(table, state.sort, state.order);
}

function bindResizing(table) {
  var storageKey = table.getAttribute("data-table-resize-key");
  var headers = Array.prototype.slice.call(table.querySelectorAll("thead th"));
  var saved = (storageKey && load(storageKey)) || {};

  headers.forEach(function (th) {
    var key = th.getAttribute("data-sort-key");
    if (key && saved[key]) th.style.width = saved[key];
  });

  function persist() {
    if (!storageKey) return;
    var tableWidth = table.offsetWidth;
    var widths = {};
    headers.forEach(function (th) {
      var key = th.getAttribute("data-sort-key");
      if (key) widths[key] = (th.offsetWidth / tableWidth) * 100 + "%";
    });
    save(storageKey, widths);
  }

  headers.slice(0, -1).forEach(function (th) {
    var next = th.nextElementSibling;
    // Not against a column with no key (e.g. a row's actions), whose width
    // isn't saved
    if (
      !th.hasAttribute("data-sort-key") ||
      !next.hasAttribute("data-sort-key")
    )
      return;
    var handle = document.createElement("span");
    handle.className = "data-table__resize";
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-orientation", "vertical");
    handle.setAttribute(
      "aria-label",
      "Resize " + th.textContent.trim() + " column"
    );
    handle.setAttribute("aria-valuemin", String(MIN_WIDTH));
    handle.setAttribute("tabindex", "0");
    th.appendChild(handle);

    function announce() {
      var width = Math.round(th.offsetWidth);
      handle.setAttribute("aria-valuenow", String(width));
      handle.setAttribute("aria-valuetext", width + " pixels");
    }

    // Moves the border between this column and the next by delta pixels,
    // within the pair's combined width, so the table keeps its width
    function resize(delta, startWidth, startNextWidth) {
      var pair = startWidth + startNextWidth;
      var width = Math.min(
        Math.max(MIN_WIDTH, startWidth + delta),
        pair - MIN_WIDTH
      );
      var tableWidth = table.offsetWidth;
      th.style.width = (width / tableWidth) * 100 + "%";
      next.style.width = ((pair - width) / tableWidth) * 100 + "%";
      announce();
    }

    announce();

    handle.addEventListener("click", function (event) {
      // A click on the handle is not a click on the header
      event.stopPropagation();
    });

    handle.addEventListener("pointerdown", function (event) {
      if (event.button !== 0) return;
      event.preventDefault();

      var startX = event.clientX;
      var startWidth = th.offsetWidth;
      var startNextWidth = next.offsetWidth;
      var moved = false;

      table.classList.add("is-resizing");
      handle.classList.add("is-resizing");
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", stop);
      document.addEventListener("pointercancel", stop);

      function move(moveEvent) {
        moved = true;
        resize(moveEvent.clientX - startX, startWidth, startNextWidth);
      }

      function stop() {
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", stop);
        document.removeEventListener("pointercancel", stop);
        table.classList.remove("is-resizing");
        handle.classList.remove("is-resizing");
        // A click without a drag changes nothing
        if (moved) persist();
      }
    });

    handle.addEventListener("keydown", function (event) {
      // Enter and Space must not reach the header, which sorts
      if (event.key === "Enter" || event.key === " ") event.stopPropagation();
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      resize(
        event.key === "ArrowRight" ? 16 : -16,
        th.offsetWidth,
        next.offsetWidth
      );
      persist();
    });
  });
}

document.querySelectorAll("table.data-table").forEach(function (table) {
  if (table.hasAttribute("data-table-sort")) bindSorting(table);
  if (table.hasAttribute("data-table-resizable")) bindResizing(table);
});

window.DataTable = { updateIndicators: updateIndicators };
