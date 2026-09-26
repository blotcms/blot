"use strict";

function initSidebarActionMenu(options) {
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

  function positionMenu(row) {
    if (!row) return;
    var offsetTop = row.offsetTop;
    if (container) {
      offsetTop -= container.scrollTop;
    }
    menuElement.style.top = offsetTop + "px";
  }

  function isUnavailable(link) {
    var menuItem = link.closest("li");
    return link.classList.contains("is-disabled") || !!(menuItem && menuItem.hidden);
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
      var value = typeof resolver === "function" ? resolver(dataset, trigger) : resolver;
      var href = null;
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

    updateMenu(trigger, row);
    positionMenu(row);

    menuElement.classList.add("is-open");
    menuElement.setAttribute("aria-hidden", "false");

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

  container.addEventListener("scroll", function () {
    if (activeRow && isMenuOpen()) {
      positionMenu(activeRow);
    }
  });

  window.addEventListener("resize", function () {
    if (activeRow && isMenuOpen()) {
      positionMenu(activeRow);
    }
  });

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

module.exports = initSidebarActionMenu;

if (typeof window !== "undefined") {
  window.initSidebarActionMenu = initSidebarActionMenu;
}
