var initSidebarActionMenu = require("./sidebar-action-menu");

var setTemplateEditorStateClass = function (className, enabled) {
  document.documentElement.classList.toggle(className, enabled);
  if (document.body) {
    document.body.classList.toggle(className, enabled);
  }
};

var templateSidebar = document.querySelector(".template-sidebar");
var templateSidebarToggle = document.querySelector(
  "[data-template-sidebar-toggle]"
);
var templateSidebarResizeHandle = document.querySelector(
  "[data-template-sidebar-resize-handle]"
);
var templateSidebarStorageKey = "template-editor-sidebar-collapsed";
var templateSidebarWidthStorageKey = "template-editor-sidebar-width";
var getTemplateSidebarCssValue = function (name, fallback) {
  var value = parseFloat(
    window.getComputedStyle(document.documentElement).getPropertyValue(name)
  );
  return isFinite(value) ? value : fallback;
};
var templateSidebarMinWidth = getTemplateSidebarCssValue(
  "--sidebar-min-width",
  140
);
var templateSidebarMaxWidth = getTemplateSidebarCssValue(
  "--sidebar-max-width",
  480
);
var templateSidebarCollapseThreshold = getTemplateSidebarCssValue(
  "--sidebar-collapse-threshold",
  templateSidebarMinWidth
);
var templateSidebarCollapsedWidth = getTemplateSidebarCssValue(
  "--sidebar-collapsed-width",
  32
);
var clampTemplateSidebarWidth = function (width) {
  return Math.round(
    Math.max(
      templateSidebarMinWidth,
      Math.min(templateSidebarMaxWidth, width)
    )
  );
};
var templateSidebarDefaultWidth = getTemplateSidebarCssValue(
  "--sidebar-default-width",
  200
);
var templateSidebarWidth = getTemplateSidebarCssValue(
  "--sidebar-width",
  templateSidebarDefaultWidth
);
var templateSidebarCollapsed = false;

try {
  templateSidebarCollapsed =
    window.localStorage.getItem(templateSidebarStorageKey) === "true";
  var storedTemplateSidebarWidth = parseFloat(
    window.localStorage.getItem(templateSidebarWidthStorageKey)
  );
  if (isFinite(storedTemplateSidebarWidth)) {
    templateSidebarWidth = clampTemplateSidebarWidth(storedTemplateSidebarWidth);
  }
} catch (err) {}

document.documentElement.style.setProperty(
  "--sidebar-width",
  templateSidebarWidth + "px"
);

var updateTemplateSidebarResizeHandle = function () {
  if (!templateSidebarResizeHandle) return;

  var width = templateSidebarCollapsed
    ? templateSidebarCollapsedWidth
    : templateSidebarWidth;
  templateSidebarResizeHandle.setAttribute(
    "aria-valuemin",
    String(templateSidebarCollapsedWidth)
  );
  templateSidebarResizeHandle.setAttribute(
    "aria-valuemax",
    String(templateSidebarMaxWidth)
  );
  templateSidebarResizeHandle.setAttribute("aria-valuenow", String(width));
  templateSidebarResizeHandle.setAttribute(
    "aria-valuetext",
    templateSidebarCollapsed ? "Sidebar collapsed" : width + " pixels"
  );
};

var persistTemplateSidebarState = function () {
  try {
    window.localStorage.setItem(
      templateSidebarStorageKey,
      templateSidebarCollapsed ? "true" : "false"
    );
    window.localStorage.setItem(
      templateSidebarWidthStorageKey,
      String(templateSidebarWidth)
    );
  } catch (err) {}
};

var setTemplateSidebarWidth = function (width) {
  templateSidebarWidth = clampTemplateSidebarWidth(width);
  document.documentElement.style.setProperty(
    "--sidebar-width",
    templateSidebarWidth + "px"
  );
  updateTemplateSidebarResizeHandle();
};

var setTemplateSidebarCollapsed = function (collapsed, persist) {
  templateSidebarCollapsed = collapsed;

  if (templateSidebar) {
    templateSidebar.classList.toggle("is-collapsed", collapsed);
  }
  setTemplateEditorStateClass(
    "template-editor-sidebar-collapsed",
    collapsed
  );

  if (templateSidebarToggle) {
    templateSidebarToggle.setAttribute(
      "aria-expanded",
      collapsed ? "false" : "true"
    );
    templateSidebarToggle.setAttribute(
      "aria-label",
      collapsed
        ? "Expand template list sidebar"
        : "Collapse template list sidebar"
    );
  }

  updateTemplateSidebarResizeHandle();

  if (persist) {
    try {
      window.localStorage.setItem(
        templateSidebarStorageKey,
        collapsed ? "true" : "false"
      );
    } catch (err) {}
  }
};

setTemplateSidebarCollapsed(templateSidebarCollapsed, false);

if (templateSidebar && templateSidebarToggle) {
  templateSidebarToggle.addEventListener("click", function () {
    setTemplateSidebarCollapsed(!templateSidebarCollapsed, true);
  });
}

if (templateSidebar && templateSidebarResizeHandle) {
  var sidebarResizeDrag = null;

  var applySidebarResizeCandidate = function (width) {
    if (width < templateSidebarCollapseThreshold) {
      setTemplateSidebarCollapsed(true, false);
    } else {
      setTemplateSidebarWidth(width);
      setTemplateSidebarCollapsed(false, false);
    }
  };

  var finishSidebarResize = function (event) {
    if (
      !sidebarResizeDrag ||
      (event && event.pointerId !== sidebarResizeDrag.pointerId)
    ) {
      return;
    }

    sidebarResizeDrag = null;
    if (document.body) {
      document.body.classList.remove("is-resizing-template-sidebar");
    }
    persistTemplateSidebarState();
  };

  templateSidebarResizeHandle.addEventListener("pointerdown", function (event) {
    if (event.button !== undefined && event.button !== 0) return;

    event.preventDefault();
    templateSidebarResizeHandle.focus();
    sidebarResizeDrag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: templateSidebarCollapsed
        ? templateSidebarCollapsedWidth
        : templateSidebarWidth,
    };
    templateSidebarResizeHandle.setPointerCapture(event.pointerId);
    if (document.body) {
      document.body.classList.add("is-resizing-template-sidebar");
    }
  });

  templateSidebarResizeHandle.addEventListener("pointermove", function (event) {
    if (!sidebarResizeDrag || event.pointerId !== sidebarResizeDrag.pointerId) {
      return;
    }

    applySidebarResizeCandidate(
      sidebarResizeDrag.startWidth + event.clientX - sidebarResizeDrag.startX
    );
  });

  templateSidebarResizeHandle.addEventListener(
    "pointerup",
    finishSidebarResize
  );
  templateSidebarResizeHandle.addEventListener(
    "pointercancel",
    finishSidebarResize
  );
  templateSidebarResizeHandle.addEventListener(
    "lostpointercapture",
    finishSidebarResize
  );
  templateSidebarResizeHandle.addEventListener("dblclick", function (event) {
    event.preventDefault();
    setTemplateSidebarWidth(templateSidebarDefaultWidth);
    setTemplateSidebarCollapsed(false, false);
    persistTemplateSidebarState();
  });

  templateSidebarResizeHandle.addEventListener("keydown", function (event) {
    var step = event.shiftKey ? 40 : 10;
    var width = templateSidebarCollapsed
      ? templateSidebarCollapsedWidth
      : templateSidebarWidth;

    if (event.key === "ArrowLeft") {
      width -= step;
    } else if (event.key === "ArrowRight") {
      width = templateSidebarCollapsed
        ? templateSidebarCollapseThreshold
        : width + step;
    } else if (event.key === "Home") {
      width = templateSidebarCollapseThreshold - 1;
    } else if (event.key === "End") {
      width = templateSidebarMaxWidth;
    } else {
      return;
    }

    event.preventDefault();
    applySidebarResizeCandidate(width);
    persistTemplateSidebarState();
  });
}

// we want to preserve the scroll offset whenever a link is clicked in the template list
// the parent container of the links on this page is:
// <div id="template-list" style="overflow-y: scroll;width: 100%;height: 100%;padding-right: 17px;">
var template_list = document.getElementById("template-list");

if (template_list) {
  Array.from(
    template_list.querySelectorAll("[data-template-list-toggle]")
  ).forEach(function (toggle) {
    var content = document.getElementById(toggle.getAttribute("aria-controls"));
    if (!content) return;

    var sectionKey = toggle.getAttribute("data-section-key");
    var sectionLabel = toggle.getAttribute("data-section-label");
    var storageKey = "template-list-section:" + sectionKey;
    var expanded = true;

    try {
      expanded = window.localStorage.getItem(storageKey) !== "collapsed";
    } catch (err) {}

    var setExpanded = function (nextExpanded, persist) {
      expanded = nextExpanded;
      if (sectionKey === "base-templates") {
        setTemplateEditorStateClass(
          "template-list-base-templates-collapsed",
          !expanded
        );
      }
      toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
      toggle.setAttribute(
        "aria-label",
        (expanded ? "Collapse " : "Expand ") + sectionLabel
      );
      content.hidden = !expanded;

      if (persist) {
        try {
          window.localStorage.setItem(
            storageKey,
            expanded ? "expanded" : "collapsed"
          );
        } catch (err) {}
      }
    };

    setExpanded(expanded, false);

    toggle.addEventListener("click", function () {
      setExpanded(!expanded, true);
    });
  });

  var scroll_offset = sessionStorage.getItem("scroll_offset");
  if (scroll_offset) {
    template_list.scrollTop = scroll_offset;
  }

  // whenever the user scrolls the template list, save the scroll offset
  template_list.addEventListener("scroll", function () {
    sessionStorage.setItem("scroll_offset", template_list.scrollTop);
  });

  var templateActionMenu = document.getElementById("template-action-menu");
  if (templateActionMenu) {
    var cleanTemplateBase = function (dataset) {
      var baseUrl = dataset.editurl || "";
      if (baseUrl) baseUrl = baseUrl.replace(/\/+$/, "");
      return baseUrl;
    };

    initSidebarActionMenu({
      container: template_list,
      menuElement: templateActionMenu,
      rowSelector: ".template-row",
      triggerSelector: ".row-action-menu__trigger",
      initialFocusKey: "use",
      linkMap: {
        use: function (dataset) {
          var baseUrl = cleanTemplateBase(dataset);
          return baseUrl ? baseUrl + "/install" : null;
        },
        source: function (dataset) {
          var baseUrl = cleanTemplateBase(dataset);
          return baseUrl ? baseUrl + "/source-code" : null;
        },
        rename: function (dataset) {
          var baseUrl = cleanTemplateBase(dataset);
          return baseUrl ? baseUrl + "/rename" : null;
        },
        "delete": function (dataset) {
          var baseUrl = cleanTemplateBase(dataset);
          return {
            href: baseUrl ? baseUrl + "/delete" : null,
            hidden: dataset.isMine !== "true" || dataset.isMirror === "true",
          };
        },
        reset: function (dataset) {
          var baseUrl = cleanTemplateBase(dataset);
          return {
            href: baseUrl ? baseUrl + "/reset" : null,
            hidden: dataset.isMirror !== "true",
          };
        },
        duplicate: function (dataset) {
          var baseUrl = cleanTemplateBase(dataset);
          return baseUrl ? baseUrl + "/duplicate" : null;
        },
      },
    });
  }

  // when the page loads, scroll to the last scroll offset
  window.addEventListener("DOMContentLoaded", function () {
    // whenever the <form action="{{{base}}}/install" is submitted, remove the scroll offset
    var install_form = document.querySelector(
      'form[action="{{{base}}}/install"]'
    );
    if (install_form) {
      install_form.addEventListener("submit", function () {
        sessionStorage.removeItem("scroll_offset");
      });
    }
  });
}
