"use strict";

// Row menus: one floating menu per list (the "..." button on each row opens
// it, and its links are filled in from the row's data attributes). Used by
// the sites table, the folder listing and the template editor's file list.
// The markup and styles are in dashboard/css/menu.css.
//
//   initRowMenu({
//     container,        // element holding the rows (clicks and scrolls)
//     menuElement,      // the menu, a positioned descendant of the page
//     rowSelector,      // default ".template-row"
//     triggerSelector,  // default ".row-action-menu__trigger"
//     initialFocusKey,  // data-menu-link to focus first (default: first link)
//     linkMap,          // data-menu-link name -> href, or function(dataset,
//                       // trigger) returning href or {href, disabled, hidden}
//   })
function initRowMenu(options) {
  options = options || {};

  var container = options.container;
  var menuElement = options.menuElement;
  var rowSelector = options.rowSelector || ".template-row";
  var triggerSelector = options.triggerSelector || ".row-action-menu__trigger";
  var linkMap = options.linkMap || {};
  var initialFocusKey = options.initialFocusKey;

  if (!container || !menuElement) return;

  var linkEntries = Object.keys(linkMap)
    .map(function (key) {
      var link = menuElement.querySelector('[data-menu-link="' + key + '"]');
      if (!link) return null;
      return { key: key, element: link };
    })
    .filter(function (entry) {
      return !!entry;
    });

  if (!linkEntries.length) return;

  var activeRow = null;
  var activeTrigger = null;

  function isMenuOpen() {
    return menuElement.classList.contains("is-open");
  }

  function closeMenu() {
    if (!isMenuOpen()) return;

    menuElement.classList.remove("is-open");
    menuElement.setAttribute("aria-hidden", "true");

    if (activeRow) {
      activeRow.classList.remove("menu-open");
    }

    if (activeTrigger) {
      activeTrigger.setAttribute("aria-expanded", "false");
    }

    activeRow = null;
    activeTrigger = null;
  }

  // Below the trigger with the right edges aligned (above it when there is
  // no room below), in the coordinates of the menu's positioned parent
  function positionMenu(trigger) {
    if (!trigger) return;
    var parent = menuElement.offsetParent || document.body;
    var parentRect;
    var scrollLeft = 0;
    var scrollTop = 0;

    if (
      parent === document.body &&
      window.getComputedStyle(parent).position === "static"
    ) {
      parentRect = { left: -window.pageXOffset, top: -window.pageYOffset };
    } else {
      var rect = parent.getBoundingClientRect();
      parentRect = {
        left: rect.left + parent.clientLeft,
        top: rect.top + parent.clientTop,
      };
      scrollLeft = parent.scrollLeft;
      scrollTop = parent.scrollTop;
    }

    var triggerRect = trigger.getBoundingClientRect();
    var width = menuElement.offsetWidth;
    var height = menuElement.offsetHeight;
    var gap = 4;

    var top = triggerRect.bottom + gap;
    if (
      top + height > window.innerHeight - gap &&
      triggerRect.top - gap - height > gap
    ) {
      top = triggerRect.top - gap - height;
    }

    var left = triggerRect.right - width;
    left = Math.min(left, window.innerWidth - width - gap);
    left = Math.max(left, gap);

    menuElement.style.left = left - parentRect.left + scrollLeft + "px";
    menuElement.style.top = top - parentRect.top + scrollTop + "px";
  }

  function isUnavailable(link) {
    var menuItem = link.closest("li");
    return (
      link.classList.contains("is-disabled") || !!(menuItem && menuItem.hidden)
    );
  }

  function applyLinkState(link, href, disabled, hidden) {
    var menuItem = link.closest("li");
    if (menuItem) menuItem.hidden = hidden;

    if (disabled || !href) {
      link.classList.add("is-disabled");
      link.setAttribute("aria-disabled", "true");
      link.removeAttribute("href");
      link.tabIndex = -1;
    } else {
      link.classList.remove("is-disabled");
      link.removeAttribute("aria-disabled");
      link.setAttribute("href", href);
      link.tabIndex = 0;
    }
  }

  function updateMenu(trigger, row) {
    if (!trigger) return;
    var dataset = Object.assign(
      {},
      (row && row.dataset) || {},
      trigger.dataset || {}
    );

    linkEntries.forEach(function (entry) {
      var resolver = linkMap[entry.key];
      var value =
        typeof resolver === "function" ? resolver(dataset, trigger) : resolver;
      var href;
      var disabled = false;
      var hidden = false;

      if (value && typeof value === "object") {
        href = value.href;
        disabled = !!value.disabled;
        hidden = !!value.hidden;
      } else {
        href = value;
      }

      if (typeof href === "string") {
        href = href.trim();
      }

      applyLinkState(entry.element, href, disabled, hidden);
    });
  }

  function focusInitialLink() {
    var target = null;

    if (initialFocusKey) {
      for (var i = 0; i < linkEntries.length; i += 1) {
        if (linkEntries[i].key === initialFocusKey) {
          if (!isUnavailable(linkEntries[i].element)) {
            target = linkEntries[i].element;
          }
          break;
        }
      }
    }

    if (!target) {
      for (var j = 0; j < linkEntries.length; j += 1) {
        if (!isUnavailable(linkEntries[j].element)) {
          target = linkEntries[j].element;
          break;
        }
      }
    }

    if (target) {
      window.requestAnimationFrame(function () {
        target.focus();
      });
    }
  }

  function openMenu(row, trigger) {
    if (!row || !trigger) return;

    if (activeRow && activeRow !== row) {
      activeRow.classList.remove("menu-open");
    }

    if (activeTrigger && activeTrigger !== trigger) {
      activeTrigger.setAttribute("aria-expanded", "false");
    }

    updateMenu(trigger, row);

    menuElement.classList.add("is-open");
    menuElement.setAttribute("aria-hidden", "false");
    positionMenu(trigger);

    row.classList.add("menu-open");
    activeRow = row;

    activeTrigger = trigger;
    activeTrigger.setAttribute("aria-expanded", "true");

    focusInitialLink();
  }

  container.addEventListener("click", function (event) {
    var trigger = event.target.closest(triggerSelector);
    if (!trigger) return;

    event.preventDefault();
    event.stopPropagation();

    var row = trigger.closest(rowSelector);
    if (!row) return;

    if (row === activeRow && isMenuOpen()) {
      closeMenu();
      return;
    }

    openMenu(row, trigger);
  });

  function reposition() {
    if (activeTrigger && isMenuOpen()) positionMenu(activeTrigger);
  }

  // Capture: scrolling the page, the container or a wide table all move the
  // trigger
  window.addEventListener("scroll", reposition, true);
  window.addEventListener("resize", reposition);

  document.addEventListener("click", function (event) {
    if (!isMenuOpen()) return;
    if (!menuElement.contains(event.target)) {
      closeMenu();
    }
  });

  document.addEventListener("keydown", function (event) {
    if (event.key !== "Escape" || !isMenuOpen()) return;

    var triggerToFocus = activeTrigger;
    closeMenu();
    if (triggerToFocus) {
      window.requestAnimationFrame(function () {
        triggerToFocus.focus();
      });
    }
  });

  function availableLinks() {
    return linkEntries
      .map(function (entry) {
        return entry.element;
      })
      .filter(function (link) {
        return !isUnavailable(link);
      });
  }

  // Arrow keys, Home and End move between the links; ArrowDown on a closed
  // menu's trigger opens it
  document.addEventListener("keydown", function (event) {
    var key = event.key;
    if (
      key !== "ArrowDown" &&
      key !== "ArrowUp" &&
      key !== "Home" &&
      key !== "End"
    ) {
      return;
    }

    if (!isMenuOpen()) {
      var trigger =
        event.target.closest && event.target.closest(triggerSelector);
      var row =
        trigger && container.contains(trigger) && trigger.closest(rowSelector);
      if (key === "ArrowDown" && row) {
        event.preventDefault();
        openMenu(row, trigger);
      }
      return;
    }

    if (!menuElement.contains(document.activeElement)) return;

    var links = availableLinks();
    if (!links.length) return;

    var index = links.indexOf(document.activeElement);
    var next;
    if (key === "Home") next = 0;
    else if (key === "End") next = links.length - 1;
    else if (key === "ArrowDown") next = (index + 1) % links.length;
    else next = (index - 1 + links.length) % links.length;

    event.preventDefault();
    links[next].focus();
  });

  menuElement.addEventListener("click", function (event) {
    event.stopPropagation();
    var link = event.target.closest("a");
    if (!link) return;

    if (link.classList.contains("is-disabled")) {
      event.preventDefault();
      return;
    }

    closeMenu();
  });

  menuElement.addEventListener("focusout", function () {
    window.requestAnimationFrame(function () {
      if (!isMenuOpen()) return;
      if (activeTrigger && document.activeElement === activeTrigger) {
        return;
      }
      if (menuElement.contains(document.activeElement)) {
        return;
      }
      closeMenu();
    });
  });
}

module.exports = initRowMenu;

if (typeof window !== "undefined") {
  window.initRowMenu = initRowMenu;
}
