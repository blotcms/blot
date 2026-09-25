var initSidebarActionMenu = require("./sidebar-action-menu");

// we want to preserve the scroll offset whenever a link is clicked in the template list
// the parent container of the links on this page is:
// <div id="template-list" style="overflow-y: scroll;width: 100%;height: 100%;padding-right: 17px;">
var template_list = document.getElementById("template-list");

if (template_list) {
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
      initialFocusKey: "settings",
      linkMap: {
        settings: function (dataset) {
          var baseUrl = cleanTemplateBase(dataset);
          return baseUrl || null;
        },
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
          return baseUrl ? baseUrl + "/delete" : null;
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
