var initSidebarActionMenu = require("./sidebar-action-menu");

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
      expanded = window.sessionStorage.getItem(storageKey) !== "collapsed";
    } catch (err) {}

    var setExpanded = function (nextExpanded, persist) {
      expanded = nextExpanded;
      toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
      toggle.setAttribute(
        "aria-label",
        (expanded ? "Collapse " : "Expand ") + sectionLabel
      );
      content.hidden = !expanded;

      if (persist) {
        try {
          window.sessionStorage.setItem(
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
